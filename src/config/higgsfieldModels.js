// Higgsfield Genjutsu models configuration (video-to-video / v2v).
// Offered in V->V when user has Higgsfield configured or selected.

const opts = (values, label = v => v) => values.map(v => ({ label: label(v), value: v }));
const RES_VID = { paramName: "resolution", options: opts(["480p", "720p", "1080p"]), default: "720p", exact: true };

export const HF_MODELS = {
  v2v: [
    {
      id: "hf/genjutsu/motion-transfer",
      name: "Genjutsu Motion Transfer · Higgsfield",
      hfModel: "higgsfield/genjutsu/motion-transfer/v1.0",
      provider: "Higgsfield",
      price: 0.35,
      params: {
        resolution: RES_VID,
        negativePrompt: false,
        seed: false,
        noPrompt: true,
      },
      hf: {
        mode: "motion-transfer",
        fields: ["video_url", "image_urls", "prompt", "resolution"],
        minImages: 1,
        maxImages: 8,
        minDuration: 4,
        maxDuration: 30,
      }
    },
    {
      id: "hf/genjutsu/object-swap",
      name: "Genjutsu Object Swap · Higgsfield",
      hfModel: "higgsfield/genjutsu/object-swap/v1.0",
      provider: "Higgsfield",
      price: 0.35,
      params: {
        resolution: RES_VID,
        negativePrompt: false,
        seed: false,
        noPrompt: true,
      },
      hf: {
        mode: "object-swap",
        fields: ["video_url", "image_urls", "prompt", "resolution"],
        minImages: 1,
        maxImages: 8,
        minDuration: 4,
        maxDuration: 30,
      }
    },
    {
      id: "hf/genjutsu/restyle",
      name: "Genjutsu Restyle · Higgsfield",
      hfModel: "higgsfield/genjutsu/restyle/v1.0",
      provider: "Higgsfield",
      price: 0.68,
      params: {
        resolution: RES_VID,
        negativePrompt: false,
        seed: false,
        noPrompt: true,
      },
      hf: {
        mode: "restyle",
        fields: ["video_url", "preset_id", "image_urls", "prompt", "resolution"],
        minImages: 0,
        maxImages: 5,
        minDuration: 4,
        maxDuration: 30,
      }
    }
  ]
};

for (const list of Object.values(HF_MODELS)) {
  for (const m of list) m.api = "higgsfield";
}

const BY_ID = new Map(Object.values(HF_MODELS).flat().map(m => [m.id, m]));
export const hfModelById = (id) => BY_ID.get(id) ?? null;
