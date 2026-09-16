import { describe, expect, it } from 'vitest';
import { MODALITY_CATALOG } from './catalog.ts';
import {
  fillWorkflow,
  getWorkflowTemplate,
  imageTo3dTemplateFor,
  WORKFLOW_TEMPLATES,
  type WorkflowTemplate,
} from './comfy-workflow.ts';
import type { ComfyJobSpec } from './protocol.ts';

/** Read a value at a dotted node-input path out of a filled graph (test helper). */
function at(graph: unknown, dottedPath: string): unknown {
  let cur: unknown = graph;
  for (const seg of dottedPath.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const LTX_SPEC: ComfyJobSpec = {
  prompt: 'a crane folding paper',
  modelId: 'ltx-2',
  workflowTemplate: 'ltx-2-distilled-gguf',
  inputs: {
    prompt: 'a crane folding paper',
    negativePrompt: 'blurry, low quality',
    width: 704,
    height: 480,
    length: 97,
    steps: 8,
  },
  seeds: [111, 222],
};

describe('fillWorkflow', () => {
  it('splices each input at its paramMap node path and stamps the candidate seed', () => {
    const graph = fillWorkflow(LTX_SPEC, 111);
    expect(at(graph, '6.inputs.text')).toBe('a crane folding paper');
    expect(at(graph, '7.inputs.text')).toBe('blurry, low quality');
    expect(at(graph, '70.inputs.width')).toBe(704);
    expect(at(graph, '70.inputs.height')).toBe(480);
    expect(at(graph, '70.inputs.length')).toBe(97);
    expect(at(graph, '72.inputs.steps')).toBe(8);
    expect(at(graph, '73.inputs.noise_seed')).toBe(111);
  });

  it('produces a distinct seed per candidate without mutating the base template', () => {
    const a = fillWorkflow(LTX_SPEC, 111);
    const b = fillWorkflow(LTX_SPEC, 222);
    expect(at(a, '73.inputs.noise_seed')).toBe(111);
    expect(at(b, '73.inputs.noise_seed')).toBe(222);
    // The registry's base template is untouched (deep-cloned per fill).
    const base = getWorkflowTemplate('ltx-2-distilled-gguf');
    expect(at(base?.graph, '73.inputs.noise_seed')).toBe(0);
    expect(at(base?.graph, '6.inputs.text')).toBe('');
  });

  it('the per-candidate seed argument wins over any seed present in inputs', () => {
    const spec: ComfyJobSpec = { ...LTX_SPEC, inputs: { ...LTX_SPEC.inputs, seed: 999 } };
    const graph = fillWorkflow(spec, 42);
    expect(at(graph, '73.inputs.noise_seed')).toBe(42);
  });

  it('preserves untouched nodes (class_type + unrelated inputs stay intact)', () => {
    const graph = fillWorkflow(LTX_SPEC, 111);
    expect(at(graph, '73.class_type')).toBe('KSamplerSelect');
    expect(at(graph, '73.inputs.sampler_name')).toBe('euler'); // Euler default preserved
    expect(at(graph, '9.class_type')).toBe('SaveVideo');
  });

  it('throws on an unknown template id', () => {
    const spec: ComfyJobSpec = { ...LTX_SPEC, workflowTemplate: 'does-not-exist' };
    expect(() => fillWorkflow(spec, 1)).toThrow(/unknown ComfyUI workflow template/);
  });

  it('throws when an input has no paramMap binding in the template', () => {
    const spec: ComfyJobSpec = { ...LTX_SPEC, inputs: { ...LTX_SPEC.inputs, bogusParam: 5 } };
    expect(() => fillWorkflow(spec, 1)).toThrow(/no paramMap binding for input "bogusParam"/);
  });

  it('fills the ACE-Step music template (tags/lyrics/seconds/steps/seed)', () => {
    const spec: ComfyJobSpec = {
      prompt: 'lofi hip hop, mellow',
      modelId: 'ace-step',
      workflowTemplate: 'ace-step-music',
      inputs: { prompt: 'lofi hip hop, mellow', lyrics: 'la la la', seconds: 30, steps: 50 },
      seeds: [7],
    };
    const graph = fillWorkflow(spec, 7);
    expect(at(graph, '14.inputs.tags')).toBe('lofi hip hop, mellow');
    expect(at(graph, '14.inputs.lyrics')).toBe('la la la');
    expect(at(graph, '17.inputs.seconds')).toBe(30);
    expect(at(graph, '3.inputs.steps')).toBe(50);
    expect(at(graph, '3.inputs.seed')).toBe(7);
  });
});

describe('workflow registry ↔ catalog consistency', () => {
  const comfyEntries = MODALITY_CATALOG.filter((m) => m.comfy !== undefined);

  it('the catalog actually has comfyui-backed entries to check', () => {
    expect(comfyEntries.length).toBeGreaterThan(0);
  });

  it('every catalog comfy.workflowTemplate resolves to a registered template', () => {
    for (const m of comfyEntries) {
      const tmpl = getWorkflowTemplate(m.comfy?.workflowTemplate ?? '');
      expect(tmpl, `missing template for ${m.id}`).toBeDefined();
    }
  });

  it("each registered template's paramMap matches its catalog entry's comfy.paramMap", () => {
    for (const m of comfyEntries) {
      const tmpl = getWorkflowTemplate(m.comfy?.workflowTemplate ?? '') as WorkflowTemplate;
      expect(tmpl.paramMap, `paramMap drift for ${m.id}`).toEqual(m.comfy?.paramMap);
    }
  });

  it('every template graph node referenced by a paramMap path exists in the graph', () => {
    for (const tmpl of Object.values(WORKFLOW_TEMPLATES)) {
      for (const binding of Object.values(tmpl.paramMap)) {
        // A binding is one path or several — several is how a joint audio+video
        // latent gets told its frame count once per half.
        for (const path of typeof binding === 'string' ? [binding] : binding) {
          const nodeId = path.split('.')[0] ?? '';
          expect(tmpl.graph[nodeId], `${tmpl.id} missing node ${nodeId}`).toBeDefined();
        }
      }
    }
  });
});

describe('image → 3D finish (grey / colour / PBR)', () => {
  const spec = (
    workflowTemplate: string,
    inputs: Record<string, number | string>,
  ): ComfyJobSpec => ({
    prompt: '',
    modelId: 'trellis2-comfy',
    workflowTemplate,
    inputs,
    seeds: [5],
    inputImage: '/tmp/mug.png',
  });

  it('every 3D template has its colour and grey siblings, for both engines', () => {
    for (const base of ['trellis2-image-to-3d', 'pixal3d-image-to-3d']) {
      expect(imageTo3dTemplateFor(base, 'pbr')).toBe(base);
      for (const finish of ['color', 'grey'] as const) {
        expect(getWorkflowTemplate(imageTo3dTemplateFor(base, finish))).toBeDefined();
      }
    }
  });

  it('PBR bakes everything: voxel colour, normal map and occlusion reach the material', () => {
    const graph = fillWorkflow(
      spec('trellis2-image-to-3d', { faces: 80000, textureSize: 1024 }),
      5,
    );
    expect(at(graph, '210.inputs.normal_map')).toEqual(['224', 0]);
    expect(at(graph, '210.inputs.occlusion')).toEqual(['233', 0]);
    expect(at(graph, '210.inputs.metallic')).toEqual(['147', 1]);
    expect(at(graph, '224.inputs.resolution')).toBe(1024);
    expect(at(graph, '12.inputs.seed')).toBe(5);
  });

  it('colour keeps the texture stage and bakes the base colour only', () => {
    const graph = fillWorkflow(
      spec('trellis2-image-to-3d-color', { faces: 80000, textureSize: 1024 }),
      5,
    );
    expect(at(graph, '12.class_type')).toBe('KSampler');
    expect(at(graph, '147.inputs.texture_size')).toBe(1024);
    expect(at(graph, '210.inputs.base_color')).toEqual(['147', 0]);
    expect(at(graph, '210.inputs.normal_map')).toBeUndefined();
    expect(at(graph, '210.inputs.metallic')).toBeUndefined();
    expect(at(graph, '224')).toBeUndefined();
    expect(at(graph, '233')).toBeUndefined();
    expect(at(graph, '9.inputs.mesh')).toEqual(['260', 0]);
  });

  it('grey stops after the shape: no texture sampler, no atlas, the decimated mesh is saved', () => {
    const graph = fillWorkflow(spec('trellis2-image-to-3d-grey', { faces: 80000 }), 5);
    expect(at(graph, '18.inputs.seed')).toBe(5);
    expect(at(graph, '12')).toBeUndefined();
    expect(at(graph, '93')).toBeUndefined();
    expect(at(graph, '118')).toBeUndefined();
    expect(at(graph, '196')).toBeUndefined();
    expect(at(graph, '186.inputs.target_face_count')).toBe(80000);
    expect(at(graph, '9.inputs.mesh')).toEqual(['238', 0]);
  });

  it('a texture size is not a grey input — fillWorkflow refuses it rather than losing it', () => {
    expect(() => fillWorkflow(spec('trellis2-image-to-3d-grey', { textureSize: 1024 }), 5)).toThrow(
      /no paramMap binding/,
    );
  });

  it('Pixal3D reads the camera from MoGe in every finish', () => {
    for (const finish of ['pbr', 'color', 'grey'] as const) {
      const graph = fillWorkflow(spec(imageTo3dTemplateFor('pixal3d-image-to-3d', finish), {}), 5);
      expect(at(graph, '298.inputs.camera_angle_x')).toEqual(['242', 0]);
      expect(at(graph, '9.class_type')).toBe('SaveGLB');
    }
  });
});
