# GhanaCropGuard model bundle

Put `model.onnx` and `meta.json` here (from ghanacropguard-ai `artifacts/models/active`;
`scripts\dev.ps1 -Stage api-model` there copies them), then restart the server.

The server loads them once at startup with onnxruntime-node and refuses a `model.onnx`
whose SHA-256 does not match `meta.json`. Until a bundle is here, `/api/v1/cropguard/health`
reports `degraded` and predictions return `503 model_unavailable`.
