"""Unit tests for scripts/mobile_memory.py on small synthetic graphs (python -m unittest, ~10 s)."""
import os
import sys
import tempfile
import unittest

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mobile_memory as mm  # noqa: E402


def make_model(nodes, inputs, outputs, initializers=()):
    graph = helper.make_graph(nodes, 'test', inputs, outputs, list(initializers))
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    return model


def run(model, feeds):
    session = ort.InferenceSession(model.SerializeToString(), sess_options=mm.session_options(),
                                   providers=['CPUExecutionProvider'])
    return session.run(None, feeds)


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def path(self, name):
        return os.path.join(self.tmp.name, name)

    def profile(self, model, feeds, name='m.onnx'):
        onnx.save(model, self.path(name))
        return mm.Profile(self.path(name), feeds)


class AttentionTest(Case):
    def model(self, heads=4, lq=96, lk=80, d=8):
        nodes = [helper.make_node('MatMul', ['q', 'kt'], ['s'], name='/attn/MatMul_1'),
                 helper.make_node('Softmax', ['s'], ['p'], name='/attn/Softmax', axis=-1),
                 helper.make_node('MatMul', ['p', 'v'], ['o'], name='/attn/MatMul_2'),
                 helper.make_node('Mul', ['o', 'two'], ['y'], name='/attn/out')]
        f = TensorProto.FLOAT
        inputs = [helper.make_tensor_value_info('q', f, [heads, lq, d]),
                  helper.make_tensor_value_info('kt', f, [heads, d, lk]),
                  helper.make_tensor_value_info('v', f, [heads, lk, d])]
        two = numpy_helper.from_array(np.asarray(2, np.float32), 'two')
        return make_model(nodes, inputs, [helper.make_tensor_value_info('y', f, [heads, lq, d])], [two])

    def test_sliced_attention_is_bit_exact_and_bounded(self):
        rng = np.random.default_rng(1)
        feeds = {'q': rng.standard_normal((4, 96, 8), np.float32), 'kt': rng.standard_normal((4, 8, 80), np.float32),
                 'v': rng.standard_normal((4, 80, 8), np.float32)}
        model = self.model()
        before = self.profile(model, feeds)
        blocks = mm.attention_blocks(model.graph, before)
        self.assertEqual(len(blocks), 1)
        report = mm.slice_attention(model, before, 96 * 80 * 4 // 3)  # forces 4 heads x 3 query chunks
        self.assertEqual(report[0]['heads'], 4)
        self.assertEqual(report[0]['queryChunks'], 3)
        onnx.checker.check_model(model)
        self.assertTrue(np.array_equal(run(self.model(), feeds)[0], run(model, feeds)[0]))
        after = self.profile(model, feeds, 'after.onnx')
        self.assertLess(after.live_peak()['peakMiB'], before.live_peak()['peakMiB'])

    def test_small_attention_is_left_alone(self):
        rng = np.random.default_rng(2)
        feeds = {'q': rng.standard_normal((4, 96, 8), np.float32), 'kt': rng.standard_normal((4, 8, 80), np.float32),
                 'v': rng.standard_normal((4, 80, 8), np.float32)}
        model = self.model()
        self.assertEqual(mm.slice_attention(model, self.profile(model, feeds), 1 << 30), [])


class ConvTransposeTest(Case):
    def test_split_along_output_channels_is_bit_exact(self):
        rng = np.random.default_rng(3)
        w = numpy_helper.from_array(rng.standard_normal((6, 10, 8, 1)).astype(np.float32), 'w')
        b = numpy_helper.from_array(rng.standard_normal(10).astype(np.float32), 'b')
        node = helper.make_node('ConvTranspose', ['x', 'w', 'b'], ['y'], name='/dec/conv_tr', kernel_shape=[8, 1],
                                strides=[4, 1])
        f = TensorProto.FLOAT
        model = make_model([node], [helper.make_tensor_value_info('x', f, [1, 6, 16, 12])],
                           [helper.make_tensor_value_info('y', f, [1, 10, 68, 12])], [w, b])
        feeds = {'x': rng.standard_normal((1, 6, 16, 12), np.float32)}
        reference = run(model, feeds)[0]
        profile = self.profile(model, feeds)
        scratch = profile.scratch(model.graph.node[0])
        self.assertEqual(scratch, 10 * 8 * 16 * 12 * 4)
        report = mm.split_conv_transpose(model, profile, scratch // 4)
        self.assertEqual(report[0]['pieces'], 4)
        onnx.checker.check_model(model)
        self.assertTrue(np.array_equal(reference, run(model, feeds)[0]))


class FoldTest(Case):
    def model(self):
        f, h = TensorProto.FLOAT, TensorProto.FLOAT16
        nodes = [
            helper.make_node('Range', ['start', 'limit', 'delta'], ['r'], name='/istft/Range'),
            helper.make_node('Mul', ['r', 'r'], ['r2'], name='/istft/Mul'),
            helper.make_node('Add', ['r2', 'one'], ['env'], name='/istft/Add'),
            helper.make_node('Div', ['x', 'env'], ['xn'], name='/istft/Div'),
            helper.make_node('Cast', ['w16'], ['w'], name='WeightFp16Cast_w', to=f),
            helper.make_node('Mul', ['xn', 'w'], ['y'], name='/out')]
        inits = [numpy_helper.from_array(np.asarray(v, np.float32), k) for k, v in
                 (('start', 0.0), ('limit', 64.0), ('delta', 1.0), ('one', 1.0))]
        inits.append(numpy_helper.from_array(np.linspace(-1, 1, 64).astype(np.float16), 'w16'))
        return make_model(nodes, [helper.make_tensor_value_info('x', f, [64])],
                          [helper.make_tensor_value_info('y', f, [64])], inits), h

    def test_folds_input_independent_math_but_keeps_float16_weight_casts(self):
        model, _ = self.model()
        feeds = {'x': np.random.default_rng(4).standard_normal(64).astype(np.float32)}
        reference = run(model, feeds)[0]
        report = mm.fold_input_independent(model, self.profile(model, feeds), 1 << 20, 1 << 20)
        self.assertEqual(report['folded'], ['env'])
        ops = [n.op_type for n in model.graph.node]
        self.assertNotIn('Range', ops)
        self.assertIn('Cast', ops)  # the float16 weight stays float16 in storage
        self.assertEqual({t.name: t.data_type for t in model.graph.initializer}['w16'], TensorProto.FLOAT16)
        self.assertTrue(np.array_equal(reference, run(model, feeds)[0]))

    def test_respects_the_byte_budget(self):
        model, _ = self.model()
        feeds = {'x': np.ones(64, np.float32)}
        report = mm.fold_input_independent(model, self.profile(model, feeds), 16, 16)
        self.assertEqual(report['folded'], [])
        self.assertIn('Range', [n.op_type for n in model.graph.node])


class ReductionTest(Case):
    def test_two_level_reductions_are_accurate(self):
        f = TensorProto.FLOAT
        length = 1 << 18
        nodes = [helper.make_node('InstanceNormalization', ['x', 'scale', 'bias'], ['y'], name='/gn/InstanceNorm',
                                  epsilon=1e-5),
                 helper.make_node('ReduceMean', ['x'], ['m'], name='/stats/ReduceMean', axes=[1, 2], keepdims=1)]
        inits = [numpy_helper.from_array(np.asarray([1.5], np.float32), 'scale'),
                 numpy_helper.from_array(np.asarray([0.25], np.float32), 'bias')]
        model = make_model(nodes, [helper.make_tensor_value_info('x', f, [2, 1, length])],
                           [helper.make_tensor_value_info('y', f, [2, 1, length]), helper.make_tensor_value_info('m', f, [2, 1, 1])],
                           inits)
        rng = np.random.default_rng(5)
        x = (rng.standard_normal((2, 1, length)) * 0.3 + 0.2).astype(np.float32)
        feeds = {'x': x}
        reference = run(model, feeds)
        report = mm.accurate_reductions(model, self.profile(model, feeds), 4096)
        self.assertEqual(sorted(r['op'] for r in report), ['InstanceNormalization', 'ReduceMean'])
        onnx.checker.check_model(model)
        y, m = run(model, feeds)
        x64 = x.astype(np.float64)
        mu = x64.mean(axis=2, keepdims=True)
        truth = (x64 - mu) / np.sqrt(((x64 - mu) ** 2).mean(axis=2, keepdims=True) + 1e-5) * 1.5 + 0.25
        self.assertGreater(mm.snr_db(truth, y), 120)
        self.assertGreater(mm.snr_db(truth, reference[0]), 100)
        self.assertGreater(mm.snr_db(reference[0], y), 100)
        self.assertLess(float(np.max(np.abs(m.ravel() - x64.mean(axis=(1, 2))))), 1e-6)
        self.assertEqual(y.shape, reference[0].shape)
        self.assertEqual(m.shape, reference[1].shape)


class ScheduleAndStorageTest(Case):
    def test_casts_move_first_and_external_data_round_trips(self):
        f = TensorProto.FLOAT
        nodes = [helper.make_node('Relu', ['x'], ['a'], name='/a'),
                 helper.make_node('Relu', ['a'], ['b'], name='/b'),
                 helper.make_node('Constant', [], ['c16'], name='/c', value=numpy_helper.from_array(
                     np.arange(4096, dtype=np.float16), 'c16')),
                 helper.make_node('Cast', ['c16'], ['c'], name='ConstFp16Cast_c', to=f),
                 helper.make_node('Add', ['b', 'c'], ['y'], name='/y')]
        model = make_model(nodes, [helper.make_tensor_value_info('x', f, [4096])],
                           [helper.make_tensor_value_info('y', f, [4096])])
        feeds = {'x': np.linspace(-2, 2, 4096).astype(np.float32)}
        reference = run(model, feeds)[0]
        self.assertEqual(mm.constants_to_initializers(model), 1)
        self.assertEqual(mm.schedule_static_nodes(model), 1)
        self.assertEqual(model.graph.node[0].op_type, 'Cast')
        mm.save(model, self.path('x.onnx'), external=True)
        self.assertTrue(os.path.exists(self.path('x.onnx.data')))
        self.assertEqual(os.stat(self.path('x.onnx.data')).st_mode & 0o777, 0o644)
        session = ort.InferenceSession(self.path('x.onnx'), sess_options=mm.session_options(),
                                       providers=['CPUExecutionProvider'])
        self.assertTrue(np.array_equal(reference, session.run(None, feeds)[0]))


class OpaqueShapesTest(Case):
    def test_sizes_hidden_from_the_planner_without_changing_results(self):
        f = TensorProto.FLOAT
        weight = np.linspace(-1, 1, 512 * 1024).astype(np.float16).reshape(512, 1024)  # 2 MiB as float32
        nodes = [helper.make_node('Cast', ['w16'], ['w'], name='WeightFp16Cast_w', to=f),
                 helper.make_node('Reshape', ['x', 'shape'], ['xr'], name='/r'),
                 helper.make_node('MatMul', ['xr', 'w'], ['y'], name='/mm')]
        inits = [numpy_helper.from_array(weight, 'w16'), numpy_helper.from_array(np.asarray([4, 512], np.int64), 'shape')]
        model = make_model(nodes, [helper.make_tensor_value_info('x', f, [1, 2, 1024])],
                           [helper.make_tensor_value_info('y', f, [4, 1024])], inits)
        feeds = {'x': np.random.default_rng(6).standard_normal((1, 2, 1024)).astype(np.float32)}
        reference = run(model, feeds)[0]
        self.assertEqual(mm.opaque_shapes(model), {'reshapes': 1, 'weightCasts': 1})
        onnx.checker.check_model(model)
        self.assertEqual([d.dim_param for d in model.graph.input[0].type.tensor_type.shape.dim],
                         ['batch', 'channels', 'frames'])
        reshape = next(n for n in model.graph.node if n.name == '/r')
        self.assertTrue(reshape.input[1].endswith('/mobile_opaque'))
        cast = next(n for n in model.graph.node if n.op_type == 'Cast')
        self.assertTrue(cast.input[0].endswith('/mobile_view'))
        self.assertTrue(np.array_equal(reference, run(model, feeds)[0]))


class LivePeakTest(Case):
    def test_views_share_buffers_and_scratch_counts(self):
        f = TensorProto.FLOAT
        nodes = [helper.make_node('Relu', ['x'], ['a'], name='/a'),
                 helper.make_node('Reshape', ['a', 'shape'], ['b'], name='/b'),
                 helper.make_node('Relu', ['b'], ['y'], name='/y')]
        shape = numpy_helper.from_array(np.asarray([256, 1024], np.int64), 'shape')
        model = make_model(nodes, [helper.make_tensor_value_info('x', f, [1024, 256])],
                           [helper.make_tensor_value_info('y', f, [256, 1024])], [shape])
        peak = self.profile(model, {'x': np.ones((1024, 256), np.float32)}).live_peak()
        self.assertAlmostEqual(peak['peakMiB'], 2.0, places=2)  # a (aliased by b) + y, each 1 MiB


if __name__ == '__main__':
    unittest.main()
