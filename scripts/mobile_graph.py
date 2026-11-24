"""Offline experimental graph preparation; never modifies the production model."""
import argparse
import collections
import hashlib
import json
import numpy as np
import onnx
from onnx import numpy_helper, helper
import onnxruntime as ort

def digest(path):
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()

def inventory(model):
    g = model.graph
    return {
        "operators": dict(collections.Counter(n.op_type for n in g.node)),
        "initializer_bytes_by_dtype": dict(collections.Counter({
            dtype: sum(numpy_helper.to_array(t).nbytes for t in g.initializer if t.data_type == dtype)
            for dtype in set(t.data_type for t in g.initializer)
        })),
        "istft_slice_nodes": [{"name": n.name, "inputs": list(n.input), "outputs": list(n.output)}
                             for n in g.node if n.op_type == "Slice" and "istft" in n.name.lower()],
    }

def prepare(src, dst):
    model = onnx.load(src)
    g = model.graph
    before = inventory(model)
    # Only small integer initializers are eligible. Floating constants must originate in ISTFT Constant nodes.
    constants = {}
    for t in g.initializer:
        if t.data_type in (onnx.TensorProto.INT32, onnx.TensorProto.INT64) and np.prod(t.dims) <= 4096:
            constants[t.name] = numpy_helper.to_array(t)
    shapes = {}
    inferred = onnx.shape_inference.infer_shapes(model)
    for v in list(inferred.graph.input) + list(inferred.graph.value_info) + list(inferred.graph.output):
        tt = v.type.tensor_type
        if tt.HasField("shape") and all(d.HasField("dim_value") for d in tt.shape.dim):
            shapes[v.name] = [d.dim_value for d in tt.shape.dim]
    folded = []
    for i, n in enumerate(list(g.node)):
        if len(n.output) != 1 or n.domain not in ("", "ai.onnx"):
            continue
        attrs = {a.name: helper.get_attribute_value(a) for a in n.attribute}
        value = None
        try:
            if n.op_type == "Constant" and "value" in attrs:
                t = attrs["value"]
                if (t.data_type in (onnx.TensorProto.INT32, onnx.TensorProto.INT64) and np.prod(t.dims) <= 4096) or ("istft" in n.name.lower() and t.data_type in (onnx.TensorProto.FLOAT, onnx.TensorProto.FLOAT16, onnx.TensorProto.DOUBLE) and np.prod(t.dims) <= 2_000_000):
                    constants[n.output[0]] = numpy_helper.to_array(t)
                continue
            if n.op_type == "Shape" and n.input[0] in shapes:
                value = np.asarray(shapes[n.input[0]], dtype=np.int64)[attrs.get("start", 0):attrs.get("end", None)]
            elif n.op_type in ("Gather", "Concat", "Slice", "Unsqueeze", "Squeeze", "Cast", "Add", "Sub", "Mul") and all(not k or k in constants for k in n.input):
                # Evaluate the exact ONNX operator using its original opset.
                inputs = [numpy_helper.from_array(constants[k], name=k) for k in dict.fromkeys(n.input) if k]
                mini = helper.make_model(helper.make_graph([n], "static", [], [helper.make_empty_tensor_value_info(n.output[0])], initializer=inputs), opset_imports=list(model.opset_import))
                mini.ir_version = model.ir_version
                from onnx.reference import ReferenceEvaluator
                value = ReferenceEvaluator(mini).run(None, {})[0]
        except (ValueError, TypeError, RuntimeError, IndexError, NotImplementedError):
            continue
        if value is None:
            continue
        integer = value.dtype in (np.int32, np.int64) and value.size <= 4096
        floating = ("istft" in n.name.lower() and n.op_type != "Cast" and value.dtype in (np.float16, np.float32, np.float64) and value.size <= 2_000_000)
        if not (integer or floating):
            continue
        constants[n.output[0]] = value
        replacement = helper.make_node("Constant", [], list(n.output), name=n.name + "_mobile_static", value=numpy_helper.from_array(value))
        g.node[i].CopyFrom(replacement)
        folded.append(n.name)
    # Remove only unused pure nodes in this flat graph; preserve graph outputs.
    if not any(a.type in (onnx.AttributeProto.GRAPH, onnx.AttributeProto.GRAPHS) for n in g.node for a in n.attribute):
        live = {o.name for o in g.output}
        keep = []
        for n in reversed(g.node):
            if any(o in live for o in n.output):
                keep.append(n)
                live.update(n.input)
        kept = list(reversed(keep))
        del g.node[:]
        g.node.extend(kept)
    onnx.checker.check_model(model)
    onnx.save(model, dst)
    return {"before": before, "after": inventory(model), "folded": folded, "sha256": digest(dst)}

def parity(src, dst):
    rng = np.random.default_rng(42)
    x = (rng.standard_normal((1,2,343980)) * 0.1).astype(np.float32)
    def run(path):
        opts = ort.SessionOptions()
        opts.enable_cpu_mem_arena = False
        opts.enable_mem_pattern = False
        opts.intra_op_num_threads = 2
        s = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
        return s.run(None, {s.get_inputs()[0].name: x})[0]
    a, b = run(src), run(dst)
    if a.shape != (1,6,2,343980) or a.shape != b.shape or not np.isfinite(b).all():
        raise RuntimeError(f"Invalid output shape or values: {a.shape}, {b.shape}")
    delta = float(np.max(np.abs(a-b)))
    if not np.allclose(a,b,rtol=1e-4,atol=1e-5):
        raise RuntimeError(f"Parity failed: max delta {delta}")
    return delta

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("source")
    p.add_argument("candidate")
    p.add_argument("report")
    args = p.parse_args()
    report = prepare(args.source, args.candidate)
    report["max_abs_delta"] = parity(args.source, args.candidate)
    with open(args.report, "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))
