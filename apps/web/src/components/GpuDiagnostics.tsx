import { useState } from 'react';

interface DiagnosticBuffer {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}
interface DiagnosticDevice {
  createBuffer(desc: {size: number; usage: number}): DiagnosticBuffer;
  createShaderModule(desc: {code: string}): unknown;
  createComputePipelineAsync(desc: unknown): Promise<{getBindGroupLayout(index: number): unknown}>;
  createBindGroup(desc: unknown): unknown;
  createCommandEncoder(): {
    beginComputePass(): {setPipeline(p: unknown): void; setBindGroup(i: number, g: unknown): void; dispatchWorkgroups(n: number): void; end(): void};
    copyBufferToBuffer(a: DiagnosticBuffer, ao: number, b: DiagnosticBuffer, bo: number, size: number): void;
    finish(): unknown;
  };
  queue: {submit(commands: unknown[]): void};
  destroy(): void;
}
interface DiagnosticAdapter {
  features: {has(name: string): boolean};
  limits: {maxBufferSize: number; maxStorageBufferBindingSize: number};
  requestDevice(): Promise<DiagnosticDevice>;
}

export function GpuDiagnostics({disabled}: {disabled: boolean}) {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState('');
  async function run() {
    setRunning(true);
    const lines = ['Secure context: ' + globalThis.isSecureContext, 'Cross-origin isolation: ' + globalThis.crossOriginIsolated];
    let device: DiagnosticDevice | undefined;
    let output: DiagnosticBuffer | undefined;
    let readback: DiagnosticBuffer | undefined;
    try {
      const gpu = (navigator as unknown as {gpu?: {requestAdapter(): Promise<DiagnosticAdapter | null>}}).gpu;
      lines.push('WebGPU API: ' + Boolean(gpu));
      if (!gpu) throw new Error('WebGPU is not exposed by this browser.');
      const adapter = await gpu.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter available.');
      lines.push('Shader f16: ' + adapter.features.has('shader-f16'));
      lines.push('Max buffer: ' + Math.round(adapter.limits.maxBufferSize / 1048576) + ' MiB');
      lines.push('Max storage binding: ' + Math.round(adapter.limits.maxStorageBufferBindingSize / 1048576) + ' MiB');
      device = await adapter.requestDevice();
      output = device.createBuffer({size: 4, usage: 128 | 4});
      readback = device.createBuffer({size: 4, usage: 1 | 8});
      const module = device.createShaderModule({code: '@group(0) @binding(0) var<storage, read_write> result: array<u32>; @compute @workgroup_size(1) fn main() { result[0] = 42u; }'});
      const pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}});
      const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: output}}]});
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const value = new Uint32Array(readback.getMappedRange())[0];
      readback.unmap();
      if (value !== 42) throw new Error('Unexpected compute result.');
      lines.push('GPU compute: PASS');
    } catch (error) {
      lines.push('GPU compute: FAIL — ' + String(error));
    } finally {
      readback?.destroy();
      output?.destroy();
      device?.destroy();
      lines.push('This small test does not establish model compatibility or available RAM.');
      setReport(lines.join('\n'));
      setRunning(false);
    }
  }
  return <section className="card">
    <h2>Mobile GPU diagnostics</h2>
    <p className="muted">Tests a tiny GPU compute operation without downloading the AI model.</p>
    <button type="button" disabled={disabled || running} onClick={() => void run()}>{running ? 'Testing GPU…' : 'Test WebGPU'}</button>
    {report && <pre style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'}}>{report}</pre>}
  </section>;
}
