"""Memory-reducing rewrites of the experimental mobile graph (Stage IV). Never touches the production model.

The same weights everywhere; the passes change how work is partitioned, scheduled and stored, so ONNX Runtime's
sequential executor holds less at once. The script measures instead of assuming:

  * shapes, execution order and tensor sizes come from one profiled ORT CPU run of each model, and the peak of
    live activations is simulated from them (`Profile.live_peak`; matches native peak RSS with memory reuse
    off to within a few MiB);
  * the rewritten model is compared with the source on the CPU execution provider: bit-exact for the exact
    passes, per-stem SNR on the music fixture when --accurate-reductions is on.

Exact passes (bit-identical output on CPU and in onnxruntime-web 1.23.2 / 1.31.1, measured)
  fold         input-independent subgraphs (the ISTFT window envelope is ~6,400 nodes) become stored constants,
               under a byte budget; float16 weight casts are never folded.
  slice        attention MatMul(Q, K^T) -> Softmax(-1) -> MatMul(., V) per head and query chunk.
  convT        ConvTranspose split along output channels (ORT materialises its whole column buffer).
  opaque       sizes hidden from ORT's allocation planner, which otherwise holds dead buffers for later
               same-size tensors (see opaque_shapes).
  schedule     input-independent nodes lead the node list, so ORT runs them just before their consumers.
  external     weights stored as external data: the browser copies them straight into tensors.
Accuracy pass (--accurate-reductions; changes summation order only)
  reductions   two-level ReduceMean / GroupNorm statistics, because onnxruntime-web's long float32 sums are
               the measured cause of the WASM-vs-native parity gap.
Opt-in (--static-shapes) for WebGPU experiments only: it triggers ORT's buffer-reuse trap on CPU/WASM.
"""
import argparse
import collections
import hashlib
import json
import math
import os
import tempfile

import numpy as np
import onnx
import onnxruntime as ort
from onnx import helper, numpy_helper

FRAMES = 343980
ALIAS_OPS = {'Reshape', 'Squeeze', 'Unsqueeze', 'Flatten', 'Identity'}
ORT_TYPES = {
    'float': (np.float32, onnx.TensorProto.FLOAT), 'float16': (np.float16, onnx.TensorProto.FLOAT16),
    'double': (np.float64, onnx.TensorProto.DOUBLE), 'int64': (np.int64, onnx.TensorProto.INT64),
    'int32': (np.int32, onnx.TensorProto.INT32), 'int8': (np.int8, onnx.TensorProto.INT8),
    'uint8': (np.uint8, onnx.TensorProto.UINT8), 'bool': (np.bool_, onnx.TensorProto.BOOL),
}


def digest(path):
    with open(path, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def session_options(threads=1, profile_prefix=None):
    opts = ort.SessionOptions()
    opts.enable_cpu_mem_arena = False
    opts.enable_mem_pattern = False
    opts.intra_op_num_threads = threads
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    if profile_prefix:
        opts.enable_profiling = True
        opts.profile_file_prefix = profile_prefix
    return opts


def fixtures(rank_shape=(1, 2, FRAMES)):
    """Deterministic inputs for profiling and parity: seeded noise, a stereo tone pair and, for the model's own
    window size, the synthesised six-stem music fixture (scripts/mobile_fixture.py). Noise and tones leave
    most stems near silent (bass at -64 dB re mix), where any rounding change is amplified, so per-stem SNR is
    only gated on the music fixture."""
    rng = np.random.default_rng(42)
    t = np.arange(rank_shape[-1], dtype=np.float64) / 44100
    tones = np.stack([0.1 * np.sin(2 * np.pi * 440 * t), 0.1 * np.sin(2 * np.pi * 660 * t)])[None]
    named = {'noise': (rng.standard_normal(rank_shape) * 0.1).astype(np.float32), 'tones': tones.astype(np.float32)}
    if tuple(rank_shape) == (1, 2, FRAMES):
        import mobile_fixture
        named['music'] = mobile_fixture.render()[0]
    return named


class Profile:
    """Execution order and exact output shapes of one ORT CPU run (graph optimization disabled)."""

    def __init__(self, model_path, feeds):
        with tempfile.TemporaryDirectory() as tmp:
            session = ort.InferenceSession(model_path, sess_options=session_options(
                profile_prefix=os.path.join(tmp, 'p')), providers=['CPUExecutionProvider'])
            session.run(None, feeds)
            with open(session.end_profiling()) as f:
                events = json.load(f)
        model = onnx.load(model_path, load_external_data=False)
        self.nodes = {n.name: n for n in model.graph.node}
        self.initializer_dims = {t.name: list(t.dims) for t in model.graph.initializer}
        self.outputs = {o.name for o in model.graph.output}
        self.order, self.kernel_us = [], collections.Counter()
        names = {np.dtype(v[0]): k for k, v in ORT_TYPES.items()}
        self.shapes = {k: (names[np.asarray(v).dtype], list(np.asarray(v).shape)) for k, v in feeds.items()}
        for e in events:
            if e.get('cat') != 'Node' or not e['name'].endswith('_kernel_time'):
                continue
            name = e['name'][:-len('_kernel_time')]
            self.order.append(name)
            self.kernel_us[name] += e['dur']
            for output, type_shape in zip(self.nodes[name].output, e['args'].get('output_type_shape', [])):
                (dtype, dims), = type_shape.items()
                self.shapes[output] = (dtype, list(dims))

    def nbytes(self, tensor):
        if tensor not in self.shapes:
            return 0
        dtype, dims = self.shapes[tensor]
        return int(np.prod(dims, dtype=np.int64)) * np.dtype(ORT_TYPES.get(dtype, (np.float32,))[0]).itemsize

    def scratch(self, node):
        """Kernel workspace that is not a graph tensor. ORT's CPU ConvTranspose materialises the whole column
        buffer, (C_out / group) * prod(kernel) * prod(input spatial) floats (measured in WASM 1.23.2 and
        1.31.1: +126 MiB for decoder.3). Conv tiles its im2col (MLAS), so it is not counted."""
        if node.op_type != 'ConvTranspose':
            return 0
        x = self.shapes.get(node.input[0], (None, None))[1]
        w = self.shapes.get(node.input[1], (None, None))[1] or self.initializer_dims.get(node.input[1])
        if not x or not w:
            return 0
        return int(w[1] * np.prod(w[2:]) * np.prod(x[2:])) * 4

    def live_peak(self):
        """Simulate ORT's sequential executor: an output is allocated when its node runs and freed after its
        last consumer; kernel scratch is alive only while its node runs. Initializers (weights) are excluded;
        they are resident for the whole session."""
        last_use = {}
        for name in self.order:
            for tensor in self.nodes[name].input:
                if tensor:
                    last_use[tensor] = name
        # View ops share their input's buffer (ORT kernel aliases); a buffer is freed with its last view.
        buffer_of, users, size_of = {}, collections.defaultdict(set), {}
        live, peak, at = 0, 0, None
        for step, name in enumerate(self.order):
            node = self.nodes[name]
            for k, tensor in enumerate(node.output):
                size = self.nbytes(tensor)
                if not size:
                    continue
                source = node.input[0] if node.input else None
                if k == 0 and node.op_type in ALIAS_OPS and source in buffer_of:
                    buffer_of[tensor] = buffer_of[source]
                else:
                    buffer_of[tensor] = tensor
                    size_of[tensor] = size
                    live += size
                users[buffer_of[tensor]].add(tensor)
            scratch = self.scratch(node)
            if live + scratch > peak:
                peak = live + scratch
                largest = {b: size_of[b] for b in users if users[b]}
                if scratch:
                    largest[name + ' (scratch)'] = scratch
                at = (step, name, sorted(largest.items(), key=lambda kv: -kv[1])[:6])
            for tensor in node.input:
                if tensor in buffer_of and last_use.get(tensor) == name and tensor not in self.outputs:
                    buffer = buffer_of.pop(tensor)
                    users[buffer].discard(tensor)
                    if not users[buffer]:
                        live -= size_of.pop(buffer)
                        del users[buffer]
        return {
            'peakMiB': round(peak / 2**20, 2), 'step': at[0] if at else None, 'node': at[1] if at else None,
            'largestLiveMiB': {k: round(v / 2**20, 2) for k, v in (at[2] if at else [])},
            'kernelSeconds': round(sum(self.kernel_us.values()) / 1e6, 3), 'nodesExecuted': len(self.order),
        }


def consumers_of(graph):
    out = collections.defaultdict(list)
    for node in graph.node:
        for tensor in node.input:
            if tensor:
                out[tensor].append(node)
    return out


def prune_dead_nodes(graph):
    live = {o.name for o in graph.output}
    keep = []
    for node in reversed(graph.node):
        if any(o in live for o in node.output):
            keep.append(node)
            live.update(i for i in node.input if i)
    removed = len(graph.node) - len(keep)
    kept = list(reversed(keep))
    del graph.node[:]
    graph.node.extend(kept)
    used = {i for n in graph.node for i in n.input} | {o.name for o in graph.output}
    initializers = [t for t in graph.initializer if t.name in used]
    del graph.initializer[:]
    graph.initializer.extend(initializers)
    return removed


def static_shapes(model, profile):
    """The model's input shape is fixed ([1, 2, 343980]), so every Shape result is a constant. Replace each
    Shape node by its value as measured in the profiled run; fold_input_independent then evaluates the
    index arithmetic built on it (Gather/Unsqueeze/Concat/Slice targets) once, offline. Exact.

    Measured trade-off: with static shapes onnxruntime-web 1.23.2 and 1.31.1 create WebGPU sessions in
    Chromium (dynamic shapes fail provider assignment at /real_istft/Slice_2041), but ORT's allocation planner
    then reuses same-size buffers and holds every freed encoder buffer until the mirrored decoder layer needs
    it: native peak 1560 MiB with memory reuse on versus 222 MiB with it off; WASM touched 1668 MiB. The web
    API cannot disable memory reuse, so this pass is opt-in."""
    g = model.graph
    replaced = 0
    for i, node in enumerate(g.node):
        if node.op_type != 'Shape' or node.input[0] not in profile.shapes:
            continue
        attrs = {a.name: helper.get_attribute_value(a) for a in node.attribute}
        dims = profile.shapes[node.input[0]][1]
        value = np.asarray(dims, dtype=np.int64)[attrs.get('start', 0):attrs.get('end', None)]
        g.node[i].CopyFrom(helper.make_node('Constant', [], list(node.output), name=node.name + '_static',
                                            value=numpy_helper.from_array(value)))
        replaced += 1
    return replaced


def fold_input_independent(model, profile, max_tensor_bytes, budget_bytes):
    """Replace input-independent tensors that feed the input-dependent graph by their values.

    A tensor is input-independent when no graph input reaches it. Only single-output producers are folded,
    never a Cast of float16 data (that is a weight cast; folding it would store the weight as float32), and
    only within the per-tensor and total byte budgets."""
    g = model.graph
    dynamic = {i.name for i in g.input}
    for node in g.node:  # ONNX nodes are topologically sorted
        if any(i in dynamic for i in node.input):
            dynamic.update(node.output)
    producer = {o: n for n in g.node for o in n.output}
    elem_type = {t.name: t.data_type for t in g.initializer}
    for node in g.node:
        if node.op_type == 'Constant':
            elem_type[node.output[0]] = helper.get_attribute_value(node.attribute[0]).data_type
    for tensor, (dtype, _) in profile.shapes.items():
        elem_type.setdefault(tensor, ORT_TYPES[dtype][1] if dtype in ORT_TYPES else None)

    def weight_cast(node):
        return node.op_type == 'Cast' and elem_type.get(node.input[0]) == onnx.TensorProto.FLOAT16

    frontier = []
    for node in g.node:
        if not any(o in dynamic for o in node.output):
            continue
        for tensor in node.input:
            p = producer.get(tensor)
            if (tensor and tensor not in dynamic and p is not None and p.op_type != 'Constant'
                    and len(p.output) == 1 and not weight_cast(p) and tensor not in frontier):
                frontier.append(tensor)
    chosen, skipped, total = [], [], 0
    for tensor in sorted(frontier, key=profile.nbytes):
        size = profile.nbytes(tensor)
        if tensor in profile.shapes and size <= max_tensor_bytes and total + size <= budget_bytes:
            chosen.append(tensor)
            total += size
        else:
            skipped.append({'tensor': tensor, 'MiB': round(size / 2**20, 2)})
    if not chosen:
        return {'folded': [], 'skipped': skipped, 'addedMiB': 0}

    sub = onnx.ModelProto()
    sub.CopyFrom(model)
    sg = sub.graph
    static = [n for n in sg.node if not any(o in dynamic for o in n.output)]
    del sg.node[:]
    sg.node.extend(static)
    del sg.input[:]
    del sg.output[:]
    for tensor in chosen:
        sg.output.append(helper.make_tensor_value_info(tensor, elem_type[tensor], None))
    prune_dead_nodes(sg)
    session = ort.InferenceSession(sub.SerializeToString(), sess_options=session_options(),
                                   providers=['CPUExecutionProvider'])
    values = dict(zip(chosen, session.run(chosen, {})))
    folded_producers = {producer[t].name for t in chosen}
    kept = [n for n in g.node if n.name not in folded_producers]
    del g.node[:]
    g.node.extend(kept)
    for tensor in chosen:
        g.initializer.append(numpy_helper.from_array(values[tensor], name=tensor))
    removed = prune_dead_nodes(g)
    return {'folded': chosen, 'skipped': skipped[:20], 'skippedCount': len(skipped),
            'addedMiB': round(total / 2**20, 3), 'nodesRemoved': removed + len(folded_producers)}


def attention_blocks(graph, profile):
    """MatMul(A[H,Lq,d], B[H,d,Lk]) -> Softmax(axis=-1) -> MatMul(., V[H,Lk,dv]) with private intermediates."""
    consumers = consumers_of(graph)
    producer = {o: n for n in graph.node for o in n.output}
    blocks = []
    for softmax in graph.node:
        if softmax.op_type != 'Softmax':
            continue
        axis = next((helper.get_attribute_value(a) for a in softmax.attribute if a.name == 'axis'), -1)
        scores = producer.get(softmax.input[0])
        users = consumers.get(softmax.output[0], [])
        if scores is None or scores.op_type != 'MatMul' or len(users) != 1 or users[0].op_type != 'MatMul':
            continue
        if len(consumers.get(scores.output[0], [])) != 1 or users[0].input[0] != softmax.output[0]:
            continue
        a, b, v = scores.input[0], scores.input[1], users[0].input[1]
        dims = [profile.shapes.get(t, (None, None))[1] for t in (a, b, v, scores.output[0])]
        if any(d is None or len(d) != 3 for d in dims) or axis not in (-1, 2):
            continue
        (h, lq, d), (hb, db, lk), (hv, lkv, dv), _ = dims
        if not (h == hb == hv and d == db and lk == lkv):
            continue
        blocks.append({'scores': scores, 'softmax': softmax, 'values': users[0], 'H': h, 'Lq': lq, 'Lk': lk,
                       'd': d, 'dv': dv, 'scoreBytes': h * lq * lk * 4})
    return blocks


def slice_attention(model, profile, max_chunk_bytes):
    g = model.graph
    consts = {}

    def const(values):
        key = tuple(values)
        if key not in consts:
            name = 'mobile_memory_i64_' + '_'.join(str(v) for v in key).replace('-', 'm')
            consts[key] = name
            g.initializer.append(numpy_helper.from_array(np.asarray(values, dtype=np.int64), name=name))
        return consts[key]

    report = []
    replace = {}
    for blk in attention_blocks(g, profile):
        if blk['scoreBytes'] <= max_chunk_bytes:
            continue
        h, lq, lk = blk['H'], blk['Lq'], blk['Lk']
        chunks = max(1, math.ceil(lq * lk * 4 / max_chunk_bytes))
        rows = math.ceil(lq / chunks)
        chunks = math.ceil(lq / rows)
        a, b = blk['scores'].input
        v = blk['values'].input[1]
        out = blk['values'].output[0]
        base = blk['softmax'].name.rsplit('/', 1)[0] + '/mobile_sliced'
        nodes, head_outputs = [], []
        for head in range(h):
            hb, hv = f'{base}/K_{head}', f'{base}/V_{head}'
            nodes.append(helper.make_node('Slice', [b, const([head]), const([head + 1]), const([0])], [hb], name=hb))
            nodes.append(helper.make_node('Slice', [v, const([head]), const([head + 1]), const([0])], [hv], name=hv))
            chunk_outputs = []
            for c in range(chunks):
                lo, hi = c * rows, min((c + 1) * rows, lq)
                tag = f'{base}/h{head}_q{c}'
                nodes.append(helper.make_node('Slice', [a, const([head, lo]), const([head + 1, hi]), const([0, 1])],
                                              [tag + '/Q'], name=tag + '/Q'))
                nodes.append(helper.make_node('MatMul', [tag + '/Q', hb], [tag + '/scores'], name=tag + '/scores'))
                nodes.append(helper.make_node('Softmax', [tag + '/scores'], [tag + '/weights'], name=tag + '/weights',
                                              axis=-1))
                nodes.append(helper.make_node('MatMul', [tag + '/weights', hv], [tag + '/out'], name=tag + '/out'))
                chunk_outputs.append(tag + '/out')
            if len(chunk_outputs) == 1:
                head_outputs.append(chunk_outputs[0])
            else:
                name = f'{base}/head{head}'
                nodes.append(helper.make_node('Concat', chunk_outputs, [name], name=name, axis=1))
                head_outputs.append(name)
        nodes.append(helper.make_node('Concat', head_outputs, [out], name=base + '/heads', axis=0))
        replace[blk['values'].name] = nodes
        replace[blk['softmax'].name] = []
        replace[blk['scores'].name] = []
        report.append({'block': blk['softmax'].name.rsplit('/', 1)[0], 'heads': h, 'queryChunks': chunks,
                       'scoreMiBBefore': round(blk['scoreBytes'] / 2**20, 2),
                       'scoreMiBAfter': round(rows * lk * 4 / 2**20, 2)})
    rebuilt = []
    for node in g.node:
        rebuilt.extend(replace.get(node.name, [node]))
    del g.node[:]
    g.node.extend(rebuilt)
    return report


def _block(length):
    """Divisor of `length` closest to its square root (the inner block of a two-level reduction)."""
    best = 1
    for k in range(1, math.isqrt(length) + 1):
        if length % k == 0:
            best = k
    return best


def accurate_reductions(model, profile, min_elements):
    """Two-level reductions for long float32 means and variances.

    onnxruntime-web's ReduceMean and InstanceNormalization accumulate long float32 sums less accurately than
    the native CPU kernels: on the model's own tensors, 77-81 dB against a float64 truth in WASM versus
    101-107 dB natively. Those statistics normalise the input and every DConv GroupNorm (up to 8,255,520
    elements per instance), and the error is amplified downstream. Reducing over ~sqrt(L)-element blocks and
    then over the block results keeps every float32 sum short on any backend. The arithmetic is the same
    two-pass mean and variance the native kernel computes; only the summation order changes, so outputs move
    by rounding-level amounts and must be validated by SNR rather than bit equality."""
    g = model.graph
    stored = {t.name: numpy_helper.to_array(t) for t in g.initializer}
    stored.update({n.output[0]: numpy_helper.to_array(helper.get_attribute_value(n.attribute[0]))
                   for n in g.node if n.op_type == 'Constant'})
    added = {}

    def const(name, value):
        if name not in added:
            added[name] = numpy_helper.from_array(np.asarray(value), name=name)
            g.initializer.append(added[name])
        return name

    def i64(values):
        return const('mobile_red_i64_' + '_'.join(str(v) for v in values), np.asarray(values, dtype=np.int64))

    def f32(value):
        return const('mobile_red_f32_' + repr(float(value)).replace('.', 'p').replace('-', 'm'),
                     np.asarray(value, dtype=np.float32))

    report, replace = [], {}
    for node in g.node:
        if node.op_type not in ('InstanceNormalization', 'ReduceMean'):
            continue
        dims = profile.shapes.get(node.input[0], (None, None))[1]
        if profile.shapes.get(node.input[0], ('',))[0] != 'float' or not dims:
            continue
        attrs = {a.name: helper.get_attribute_value(a) for a in node.attribute}
        base = node.name + '/mobile_two_level'
        if node.op_type == 'InstanceNormalization':
            if len(dims) != 3 or dims[2] < min_elements:
                continue
            n, c, length = dims
            k = _block(length)
            blocks = length // k
            if k < 32:
                continue
            scale, bias = stored.get(node.input[1]), stored.get(node.input[2])
            if scale is None or bias is None:
                continue
            # Statistics without full-size temporaries: block sums of x and x^2 (views and small tensors only),
            # var = E[x^2] - E[x]^2 clamped at 0. One BatchNormalization over the N*C instances then normalises
            # with a single output allocation, as the original InstanceNormalization did.
            x, nc = base + '/x', n * c
            new = [helper.make_node('Reshape', [node.input[0], i64([1, nc, blocks, k])], [x], name=x),
                   helper.make_node('ReduceMean', [x], [base + '/m1'], name=base + '/m1', axes=[3], keepdims=1),
                   helper.make_node('ReduceMean', [base + '/m1'], [base + '/m'], name=base + '/m', axes=[2], keepdims=0),
                   helper.make_node('ReduceSumSquare', [x], [base + '/q1'], name=base + '/q1', axes=[3], keepdims=1),
                   helper.make_node('ReduceSum', [base + '/q1', i64([2])], [base + '/q'], name=base + '/q', keepdims=0),
                   helper.make_node('Div', [base + '/q', f32(length)], [base + '/ex2'], name=base + '/ex2'),
                   helper.make_node('Mul', [base + '/m', base + '/m'], [base + '/m2'], name=base + '/m2'),
                   helper.make_node('Sub', [base + '/ex2', base + '/m2'], [base + '/v'], name=base + '/v'),
                   helper.make_node('Max', [base + '/v', f32(0.0)], [base + '/var'], name=base + '/var'),
                   helper.make_node('Reshape', [base + '/m', i64([nc])], [base + '/mean'], name=base + '/mean'),
                   helper.make_node('Reshape', [base + '/var', i64([nc])], [base + '/variance'], name=base + '/variance'),
                   helper.make_node('Reshape', [node.input[0], i64([1, nc, length])], [base + '/xc'], name=base + '/xc'),
                   helper.make_node('BatchNormalization',
                                    [base + '/xc', const(base + '/scale', np.tile(scale.astype(np.float32), n)),
                                     const(base + '/bias', np.tile(bias.astype(np.float32), n)),
                                     base + '/mean', base + '/variance'], [base + '/y'], name=base + '/y',
                                    epsilon=float(attrs.get('epsilon', 1e-5))),
                   helper.make_node('Reshape', [base + '/y', i64(dims)], list(node.output), name=base + '/out')]
        else:
            axes = sorted(a % len(dims) for a in attrs.get('axes', range(len(dims))))
            if attrs.get('keepdims', 1) != 1 or axes != list(range(axes[0], len(dims))):
                continue
            length = int(np.prod([dims[a] for a in axes]))
            k = _block(length)
            if length < min_elements or k < 32:
                continue
            lead = dims[:axes[0]]
            x = base + '/x'
            new = [helper.make_node('Reshape', [node.input[0], i64(lead + [length // k, k])], [x], name=x),
                   helper.make_node('ReduceMean', [x], [base + '/m1'], name=base + '/m1', axes=[len(lead) + 1],
                                    keepdims=1),
                   helper.make_node('ReduceMean', [base + '/m1'], [base + '/m'], name=base + '/m', axes=[len(lead)],
                                    keepdims=1),
                   helper.make_node('Reshape', [base + '/m', i64(lead + [1] * len(axes))], list(node.output),
                                    name=base + '/out')]
        replace[node.name] = new
        report.append({'node': node.name, 'op': node.op_type, 'elements': length if node.op_type == 'ReduceMean'
                       else dims[2], 'blocks': length // k if node.op_type == 'ReduceMean' else blocks, 'block': k})
    rebuilt = []
    for node in g.node:
        rebuilt.extend(replace.get(node.name, [node]))
    del g.node[:]
    g.node.extend(rebuilt)
    return report


def split_conv_transpose(model, profile, max_scratch_bytes):
    """ORT's CPU ConvTranspose holds a column buffer for every output channel at once. Splitting the weight
    and bias along the output-channel axis gives k independent ConvTransposes (same GEMM reduction over the
    input channels, same col2im accumulation order), concatenated back along the channel axis."""
    g = model.graph
    consts = {}

    def const(values):
        key = tuple(values)
        if key not in consts:
            name = 'mobile_memory_ct_' + '_'.join(str(v) for v in key)
            consts[key] = name
            g.initializer.append(numpy_helper.from_array(np.asarray(values, dtype=np.int64), name=name))
        return consts[key]

    report, replace = [], {}
    for node in g.node:
        if node.op_type != 'ConvTranspose':
            continue
        attrs = {a.name: helper.get_attribute_value(a) for a in node.attribute}
        scratch = profile.scratch(node)
        w = profile.shapes.get(node.input[1], (None, None))[1] or profile.initializer_dims.get(node.input[1])
        if attrs.get('group', 1) != 1 or scratch <= max_scratch_bytes or not w or 'output_shape' in attrs:
            continue
        channels = w[1]
        pieces = min(channels, math.ceil(scratch / max_scratch_bytes))
        width = math.ceil(channels / pieces)
        outputs = []
        for start in range(0, channels, width):
            stop = min(start + width, channels)
            tag = f'{node.name}/mobile_split_{start}'
            inputs = [node.input[0], tag + '/W']
            new = [helper.make_node('Slice', [node.input[1], const([start]), const([stop]), const([1])],
                                    [tag + '/W'], name=tag + '/W')]
            if len(node.input) > 2 and node.input[2]:
                new.append(helper.make_node('Slice', [node.input[2], const([start]), const([stop]), const([0])],
                                            [tag + '/B'], name=tag + '/B'))
                inputs.append(tag + '/B')
            conv = helper.make_node('ConvTranspose', inputs, [tag + '/Y'], name=tag)
            conv.attribute.extend(node.attribute)
            new.append(conv)
            replace.setdefault(node.name, []).extend(new)
            outputs.append(tag + '/Y')
        replace[node.name].append(helper.make_node('Concat', outputs, list(node.output), name=node.name + '/mobile_concat',
                                                   axis=1))
        report.append({'node': node.name, 'pieces': len(outputs), 'scratchMiBBefore': round(scratch / 2**20, 2),
                       'scratchMiBAfter': round(scratch * width / channels / 2**20, 2)})
    rebuilt = []
    for node in g.node:
        rebuilt.extend(replace.get(node.name, [node]))
    del g.node[:]
    g.node.extend(rebuilt)
    return report


def schedule_static_nodes(model):
    """ORT orders nodes by a reverse DFS from the graph outputs that visits a node's higher-indexed inputs
    first. An input-independent node (a weight Cast, an embedding Expand) placed just before its consumer
    therefore runs before the consumer's whole data path and holds its result throughout: the 32 MiB ISTFT
    basis was alive across both decoders, and once shapes are static the 31.5 MiB frequency embedding is alive
    across the time encoder. Moving input-independent nodes to the front of the node list makes them the last
    inputs visited, so they run just before their first consumer. They depend only on initializers and other
    input-independent nodes, so the node list stays topologically sorted."""
    g = model.graph
    dynamic = {i.name for i in g.input}
    static, rest = [], []
    for node in g.node:
        if any(i in dynamic for i in node.input):
            dynamic.update(node.output)
            rest.append(node)
        else:
            static.append(node)
    static.sort(key=lambda n: n.op_type != 'Constant')  # stable: constants first, then the rest in order
    del g.node[:]
    g.node.extend(static + rest)
    return sum(n.op_type != 'Constant' for n in static)


def opaque_shapes(model, min_cast_bytes=1 << 20):
    """Hide tensor sizes from ORT's allocation planner. Exact: only Identity and view Reshapes are added.

    When the planner can size two tensors at load time and they are equal, it reserves the first one's buffer
    after its last use until the second one is created. In this U-Net that holds every encoder-sized buffer
    across the bottleneck for its mirrored decoder layer, and the 32 MiB STFT basis for the ISTFT basis
    (measured: native peak 384 MiB with reuse versus 201 MiB without; the web API cannot turn reuse off).
    Reuse needs a statically known size, so: the graph input gets symbolic dimensions, every Reshape reads its
    target through an Identity (a node output, so its values are unknown at load), and each large float16
    weight Cast reads its input through such a Reshape. Graph optimisation must stay disabled, or constant
    folding would make the shapes static again."""
    g = model.graph
    for dim, name in zip(g.input[0].type.tensor_type.shape.dim, ('batch', 'channels', 'frames')):
        dim.ClearField('dim_value')
        dim.dim_param = name
    del g.value_info[:]
    stored = {t.name: t for t in g.initializer}
    stored.update({n.output[0]: helper.get_attribute_value(n.attribute[0]) for n in g.node if n.op_type == 'Constant'})
    identities, added, new_inits = {}, [], []

    def opaque(tensor):
        if tensor not in identities:
            name = tensor + '/mobile_opaque'
            identities[tensor] = name
            added.append(helper.make_node('Identity', [tensor], [name], name=name))
        return identities[tensor]

    reshapes = casts = 0
    rebuilt = []
    for node in g.node:
        if node.op_type == 'Reshape' and node.input[1] in stored:
            node.input[1] = opaque(node.input[1])
            reshapes += 1
        elif (node.op_type == 'Cast' and node.input[0] in stored
              and stored[node.input[0]].data_type == onnx.TensorProto.FLOAT16
              and int(np.prod(stored[node.input[0]].dims)) * 4 >= min_cast_bytes):
            dims = list(stored[node.input[0]].dims)
            shape_name = node.input[0] + '/mobile_shape'
            new_inits.append(numpy_helper.from_array(np.asarray(dims, np.int64), shape_name))
            view = node.input[0] + '/mobile_view'
            rebuilt.append(helper.make_node('Reshape', [node.input[0], opaque(shape_name)], [view], name=view))
            node.input[0] = view
            casts += 1
        rebuilt.append(node)
    g.initializer.extend(new_inits)
    del g.node[:]
    g.node.extend(added + rebuilt)  # Identities read only initializers, so they may lead the node list
    return {'reshapes': reshapes, 'weightCasts': casts}


def constants_to_initializers(model, min_bytes=1024):
    """Constant nodes become initializers (ORT does the same at load) so they can be stored externally."""
    g = model.graph
    kept, moved = [], 0
    for node in g.node:
        if node.op_type == 'Constant' and len(node.attribute) == 1 and node.attribute[0].name == 'value':
            tensor = helper.get_attribute_value(node.attribute[0])
            if numpy_helper.to_array(tensor).nbytes >= min_bytes:
                t = onnx.TensorProto()
                t.CopyFrom(tensor)
                t.name = node.output[0]
                g.initializer.append(t)
                moved += 1
                continue
        kept.append(node)
    del g.node[:]
    g.node.extend(kept)
    return moved


def save(model, path, external):
    prune_dead_nodes(model.graph)
    onnx.checker.check_model(model)
    data_name = os.path.basename(path) + '.data'
    if external:
        if os.path.exists(os.path.join(os.path.dirname(path), data_name)):
            os.remove(os.path.join(os.path.dirname(path), data_name))
        onnx.save_model(model, path, save_as_external_data=True, all_tensors_to_one_file=True,
                        location=data_name, size_threshold=1024)
        os.chmod(os.path.join(os.path.dirname(path) or '.', data_name), 0o644)  # onnx writes 0600; it is served
    else:
        onnx.save_model(model, path)


STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano']


def snr_db(reference, actual):
    reference = reference.astype(np.float64)
    error = np.mean(np.square(actual.astype(np.float64) - reference))
    signal = np.mean(np.square(reference))
    return math.inf if error == 0 else (10 * math.log10(signal / error) if signal else -math.inf)


def parity(reference_path, candidate_path, inputs, threads=1):
    def run(path):
        session = ort.InferenceSession(path, sess_options=session_options(threads),
                                       providers=['CPUExecutionProvider'])
        name = session.get_inputs()[0].name
        return {key: session.run(None, {name: x})[0] for key, x in inputs.items()}
    result = {}
    reference, candidate = run(reference_path), run(candidate_path)
    for key in inputs:
        ref, out = reference[key], candidate[key]
        if ref.shape != out.shape or not np.isfinite(out).all():
            raise RuntimeError(f'Invalid output shape or values: {ref.shape}, {out.shape}')
        stems = {name: snr_db(ref[0, i], out[0, i]) for i, name in enumerate(STEMS)} if ref.ndim == 4 else {}
        result[key] = {'maxAbs': float(np.max(np.abs(ref - out))), 'bitExact': bool(np.array_equal(ref, out)),
                       'minStemSnrDb': min(stems.values()) if stems else None,
                       'stemSnrDb': {k: (round(v, 2) if math.isfinite(v) else str(v)) for k, v in stems.items()}}
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('source')
    p.add_argument('candidate')
    p.add_argument('report')
    p.add_argument('--max-attention-mib', type=float, default=8.0,
                   help='largest score matrix (per head and query chunk) held at once')
    p.add_argument('--max-scratch-mib', type=float, default=16.0,
                   help='largest ConvTranspose column buffer held at once')
    p.add_argument('--fold-max-mib', type=float, default=4.0, help='largest input-independent tensor to store')
    p.add_argument('--fold-budget-mib', type=float, default=8.0, help='total bytes the fold pass may add')
    p.add_argument('--external-data', action='store_true', help='store weights in <candidate>.data')
    p.add_argument('--accurate-reductions', action='store_true',
                   help='rewrite long ReduceMean/InstanceNormalization as two-level reductions (not bit-exact)')
    p.add_argument('--min-reduction-elements', type=int, default=16384,
                   help='shortest reduction rewritten by --accurate-reductions')
    p.add_argument('--min-stem-snr-db', type=float, default=40.0,
                   help='with --accurate-reductions: lowest per-stem CPU SNR against the source on the music '
                        'fixture (the project parity contract)')
    p.add_argument('--static-shapes', action='store_true',
                   help='replace Shape nodes by constants (lets WebGPU sessions initialise in Chromium). WARNING: '
                        'once shapes are static, ORT plans same-size buffer reuse and keeps dead encoder buffers '
                        'until the decoder reuses them: +1.3 GiB peak on CPU/WASM (measured). Not for WASM.')
    p.add_argument('--tolerance', type=float, default=0.0,
                   help='without --accurate-reductions: largest CPU max-abs difference accepted (default: bit-exact)')
    args = p.parse_args()

    feed = {'mix': fixtures()['noise']}
    before = Profile(args.source, feed)
    model = onnx.load(args.source)
    report = {'sourceSha256': digest(args.source), 'before': before.live_peak()}
    report['staticShapes'] = static_shapes(model, before) if args.static_shapes else 0
    report['fold'] = fold_input_independent(model, before, int(args.fold_max_mib * 2**20),
                                            int(args.fold_budget_mib * 2**20))
    report['reductions'] = (accurate_reductions(model, before, args.min_reduction_elements)
                            if args.accurate_reductions else [])
    report['attention'] = slice_attention(model, before, int(args.max_attention_mib * 2**20))
    report['convTranspose'] = split_conv_transpose(model, before, int(args.max_scratch_mib * 2**20))
    report['constantsMoved'] = constants_to_initializers(model) if args.external_data else 0
    report['opaqueShapes'] = opaque_shapes(model) if not args.static_shapes else None
    report['staticNodesScheduled'] = schedule_static_nodes(model)
    save(model, args.candidate, args.external_data)
    report['candidateSha256'] = digest(args.candidate)
    if args.external_data:
        report['candidateDataSha256'] = digest(args.candidate + '.data')
    after = Profile(args.candidate, feed)
    report['after'] = after.live_peak()
    report['operatorsAfter'] = dict(collections.Counter(n.op_type for n in model.graph.node))
    report['parity'] = {f'threads{t}': parity(args.source, args.candidate, fixtures(), t) for t in (1, 4)}
    with open(args.report, 'w') as f:
        json.dump(report, f, indent=2)
    print(json.dumps({k: report[k] for k in ('before', 'after', 'parity', 'candidateSha256')}, indent=2))
    runs = [r for rs in report['parity'].values() for r in rs.values()]
    if args.accurate_reductions:
        worst = min(rs['music']['minStemSnrDb'] for rs in report['parity'].values())
        if worst < args.min_stem_snr_db:
            raise SystemExit(f'CPU parity failed on the music fixture: per-stem SNR {worst:.2f} dB < '
                             f'{args.min_stem_snr_db} dB')
    else:
        worst = max(r['maxAbs'] for r in runs)
        if worst > args.tolerance:
            raise SystemExit(f'CPU parity failed: max abs difference {worst} > {args.tolerance}')


if __name__ == '__main__':
    main()
