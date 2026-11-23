#!/usr/bin/env python3
"""Make an htdemucs ONNX export placeable by onnxruntime-web's WebGPU EP.

The upstream export's inverse-STFT contains `ConstantOfShape` nodes whose input
is a shape sub-graph. With the fixed `mix [1, 2, 343980]` input their outputs are
static, so we evaluate them once and replace each with a `Constant`.

Why not ORT `ENABLE_BASIC` offline optimisation (how the published WebGPU
variant was produced)? Basic constant folding also folds the fp16→fp32 `Cast`s
on initializers, silently re-inflating an fp16-stored-weights model to fp32.
This script touches *only* ConstantOfShape nodes.

Usage:
  python scripts/fold_webgpu.py in.onnx out.onnx
Prints the output sha256 and a CPU parity check (max |Δ|) against the input.
"""
from __future__ import annotations

import hashlib
import sys

import numpy as np
import onnx
import onnxruntime as ort
from onnx import helper, numpy_helper

SEGMENT = 343_980


def fold(src: str, dst: str) -> None:
    model = onnx.load(src)
    graph = model.graph
    targets = [n for n in graph.node if n.op_type == "ConstantOfShape"]
    if not targets:
        print("no ConstantOfShape nodes; nothing to fold")
        onnx.save(model, dst)
        return
    print(f"folding {len(targets)} ConstantOfShape node(s)")

    # 1. Expose every target output and evaluate once with the fixed input shape.
    probe = onnx.ModelProto()
    probe.CopyFrom(model)
    existing = {o.name for o in probe.graph.output}
    for n in targets:
        if n.output[0] not in existing:
            probe.graph.output.append(helper.make_empty_tensor_value_info(n.output[0]))
    sess = ort.InferenceSession(probe.SerializeToString(), providers=["CPUExecutionProvider"])
    feed = {sess.get_inputs()[0].name: np.zeros((1, 2, SEGMENT), dtype=np.float32)}
    names = [n.output[0] for n in targets]
    values = dict(zip(names, sess.run(names, feed)))

    # 2. Replace each node with a Constant carrying the evaluated tensor.
    for n in targets:
        value = values[n.output[0]]
        const = helper.make_node("Constant", [], [n.output[0]], value=numpy_helper.from_array(value, name=n.output[0] + "_folded"), name=n.name + "_folded")
        idx = list(graph.node).index(n)
        graph.node.remove(n)
        graph.node.insert(idx, const)
        print(f"  {n.name}: shape {value.shape} dtype {value.dtype} ({value.nbytes / 1e6:.1f} MB)")

    # 3. Drop shape sub-graphs that now feed nothing.
    while True:
        used = {i for node in graph.node for i in node.input} | {o.name for o in graph.output}
        dead = [node for node in graph.node if all(o not in used for o in node.output)]
        if not dead:
            break
        for node in dead:
            graph.node.remove(node)
    onnx.checker.check_model(model, full_check=False)
    onnx.save(model, dst)


def parity(a: str, b: str) -> float:
    rng = np.random.default_rng(0)
    x = (rng.standard_normal((1, 2, SEGMENT)) * 0.1).astype(np.float32)
    ya = ort.InferenceSession(a, providers=["CPUExecutionProvider"]).run(None, {"mix": x})[0]
    yb = ort.InferenceSession(b, providers=["CPUExecutionProvider"]).run(None, {"mix": x})[0]
    return float(np.max(np.abs(ya - yb)))


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    fold(src, dst)
    remaining = sum(n.op_type == "ConstantOfShape" for n in onnx.load(dst).graph.node)
    print(f"ConstantOfShape remaining: {remaining}")
    print(f"parity max|Δ| vs input: {parity(src, dst):.3e}")
    print(f"sha256 {sha256(dst)}")
