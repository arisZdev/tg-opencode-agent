// model catalog for the wizard menu
// provider ids: "google" (free tier, works from CI), "openrouter" (free :free models), "opencode" (zen; free tier may be blocked from servers)

export const GEMINI_MODELS = [
  { id: "google/gemini-flash-latest", label: "⭐ Gemini Flash (رایگان و پایدار)", provider: "google" },
  { id: "google/gemini-3.6-flash", label: "Gemini 3.6 Flash", provider: "google" },
  { id: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", provider: "google" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (سهمیه محدود)", provider: "google" },
];

// opencode zen free ids (labels rendered dynamically; fallback list)
export const ZEN_FALLBACK = [
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "big-pickle",
  "beam-free",
  "mimo-v2.6-flash-free",
  "nemotron-3.5-super-vl-free",
  "nemotron-3.5-lightning-free",
  "jev-1.13-free",
  "longcat-2.5-preview-free",
  "space-bunny-free",
];

export function zenLabel(id) {
  const m = {
    "deepseek-v4.1-flash-free": "DeepSeek v4.1 Flash",
    "glm-5.3-flash-free": "GLM 5.3 Flash",
    "big-pickle": "Big Pickle",
    "beam-free": "Beam",
    "mimo-v2.6-flash-free": "MiMo v2.6 Flash",
    "nemotron-3.5-super-vl-free": "Nemotron 3.5 Super VL",
    "nemotron-3.5-lightning-free": "Nemotron 3.5 Lightning",
    "jev-1.13-free": "JEV 1.13",
    "longcat-2.5-preview-free": "LongCat 2.5 Preview",
    "space-bunny-free": "Space Bunny",
  };
  return (m[id] || id) + " (Zen)";
}
