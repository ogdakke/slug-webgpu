import { Font } from "text-shaper";
import { prepareText } from "./slug";
import vertexShaderSource from "./SlugVertexShader.wgsl?raw";
import fragmentShaderSource from "./SlugPixelShader.wgsl?raw";

const TEX_WIDTH = 4096;

async function main() {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;

  // WebGPU init
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "premultiplied" });

  // Load font
  const fontData = await fetch("/Inter.ttf").then((r) => r.arrayBuffer());
  const font = Font.load(fontData);

  const text = "Hello Slug";
  const fontSize = 200;

  // Prepare Slug data
  const slugData = prepareText(font, text, fontSize);

  device.onuncapturederror = (e) => console.error("GPU error:", e.error.message);

  // Center text on screen (Y-up coordinate system)
  const scale = font.scaleForSize(fontSize);
  const totalWidth = slugData.totalAdvance * scale;
  const ascender = font.ascender * scale;
  const descender = font.descender * scale;
  const textHeight = ascender - descender;
  const offsetX = (canvas.width - totalWidth) / 2;
  const offsetY = (canvas.height - textHeight) / 2 + (-descender);

  // Upload vertex buffer (20 floats = 80 bytes per vertex)
  const vertexBuffer = device.createBuffer({
    size: slugData.vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, slugData.vertices);

  // Upload index buffer
  const indexBuffer = device.createBuffer({
    size: slugData.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, slugData.indices);

  // Create curve texture (RGBA32Float)
  const curveTexture = device.createTexture({
    size: { width: TEX_WIDTH, height: slugData.curveTexHeight },
    format: "rgba32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: curveTexture },
    slugData.curveTexData,
    { bytesPerRow: TEX_WIDTH * 16 },
    { width: TEX_WIDTH, height: slugData.curveTexHeight },
  );

  // Create band texture (RGBA32Uint)
  const bandTexture = device.createTexture({
    size: { width: TEX_WIDTH, height: slugData.bandTexHeight },
    format: "rgba32uint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: bandTexture },
    slugData.bandTexData,
    { bytesPerRow: TEX_WIDTH * 16 },
    { width: TEX_WIDTH, height: slugData.bandTexHeight },
  );

  // Uniform buffer: ParamStruct = slug_matrix (4 × vec4) + slug_viewport (vec4) = 80 bytes
  const uniformData = new Float32Array(20);
  // Orthographic projection (Y-up pixel coords → clip space) with centering baked in
  uniformData.set([
    2 / canvas.width,   0,                  0, offsetX * 2 / canvas.width - 1,   // row 0: x_clip
    0,                  2 / canvas.height,  0, offsetY * 2 / canvas.height - 1,  // row 1: y_clip
    0,                  0,                  0,  0,                               // row 2: z_clip
    0,                  0,                  0,  1,                               // row 3: w_clip
  ], 0);
  // Viewport dimensions
  uniformData.set([canvas.width, canvas.height, 0, 0], 16);

  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniformBuffer, 0, uniformData);

  // Bind group layout
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    ],
  });

  // Shader modules (separate for vertex and fragment)
  const vertexModule = device.createShaderModule({ code: vertexShaderSource });
  const fragmentModule = device.createShaderModule({ code: fragmentShaderSource });

  // Render pipeline — 5 vertex attributes, 80-byte stride
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: vertexModule,
      entryPoint: "main",
      buffers: [
        {
          arrayStride: 80,
          attributes: [
            { shaderLocation: 0, offset: 0,  format: "float32x4" }, // pos
            { shaderLocation: 1, offset: 16, format: "float32x4" }, // tex
            { shaderLocation: 2, offset: 32, format: "float32x4" }, // jac
            { shaderLocation: 3, offset: 48, format: "float32x4" }, // bnd
            { shaderLocation: 4, offset: 64, format: "float32x4" }, // col
          ],
        },
      ],
    },
    fragment: {
      module: fragmentModule,
      entryPoint: "main",
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });

  // Bind group
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: curveTexture.createView() },
      { binding: 2, resource: bandTexture.createView() },
    ],
  });

  // Render
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: ctx.getCurrentTexture().createView(),
        clearValue: { r: 0.05, g: 0.05, b: 0.1, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.setVertexBuffer(0, vertexBuffer);
  pass.setIndexBuffer(indexBuffer, "uint32");
  pass.drawIndexed(slugData.indices.length);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

main().catch(console.error);
