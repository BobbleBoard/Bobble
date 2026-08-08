critical: tool dropdowns not generic code blocks, custom ui for each, just like web search for example currently is. file edits/writes parsed live and open and focus canvas to them, running python/bash opens a terminal in the canvas and shows it there. and another critical thing is latency, thing I found (https://github.com/co-l/cache-hunter)) TTFT and decode speed being minimized as hard as possible and aggresive adaption per hardware to provide a seamless out of the box extremely high performance experience in 90+% of cases for hardware, this includes amd and intel gpus, 
0. third UI mode default, rename the app 'bobble', custom UI style. add to onboarding and settings canvas/inline option for visuals/files and onboarding checking for installed opencode/hermes/pi and offer importing from any (just show options to import from any that are installed).
1. tripo style 3d workspace, trellis generation, autoremesher(Now MIT liscnesed as of last month!!! https://github.com/huxingyi/autoremesher)), auto rigging (https://github.com/VAST-AI-Research/SkinTokens?tab=MIT-1-ov-file), nvidia ARDY for animation generation working
2. 3d/image/video/audio/music baseline generation working and tested, from the chat model should be able to call a tool to generate any of this or call 
3. specailists/workflows eg. vlm see and prompt for edits/regen image + mark and save best, presnet best up to n iterations loops working to be called as tools from regular chat/corp as specialists.
4. cmd+; for screenshot and access the app quick chat from anywhere, configurable keybind
5. computer use UI click through invisible overlay+fake cursor for visual of where the model moves and clicks and acts etc. on any app being used; any app can be used in the background without interrupting the user quickly and efficiently, find optimizations, these are slow processes.
6. cognee memory https://github.com/topoteretes/cognee
7. autonomous fine tuning/specializing models/workflows for given task



links of interest possibly for various purpouses (performance/hardware compatibily/modalities/capability) 

misc
minimax h3 — the user 2026-08-06: people at comfy have got it running on a lot lower end hardware reasonably. worth a look for the "runs well on modest machines" requirement.
https://github.com/co-l/cache-hunter
https://github.com/topoteretes/cognee
https://github.com/headroomlabs-ai/headroom   (Apache-2.0 context compression for agents; python+rust, local-first, library/proxy/MCP. 60-95% fewer tokens on JSON, ~20% on coding agents; content-aware — SmartCrusher for JSON, AST for code, Kompress-v2-base for text; reversible via cached-content retrieval. NOTE: its "live-zone compression preserves prompt cache hits" is directly relevant to our prefix-caching work)

APPLE SILICON / MLX PORTS — we are on PyTorch MPS everywhere; MLX is typically 3-5x faster
https://github.com/pedronaugusto/trellis2-apple            (TRELLIS.2 MLX backend + Metal mesh postproc — vs our current shivampkumar/trellis-mac, which is MPS)
https://huggingface.co/mlx-community/SkinTokens-bf16       (SkinTokens on Apple Silicon, 1.68GB bf16 — CONTRADICTS the "CUDA-only" finding; outputs a VRoid bone template, not ARDY cskel27)
https://huggingface.co/AgenticVibes/hunyuan3d-2.1-mlx      (MLX texture gen, reports ~3-5x faster UNet than PyTorch MPS)
https://github.com/Tencent-Hunyuan/HY-Motion-1.0           (text-to-3D-human-motion, open source — the ARDY alternative; ARDY is Ubuntu+NVIDIA only)

audio
https://github.com/pwilkin/thinksound.cpp
https://github.com/QwenLM/Qwen3-TTS   (the user 2026-08-06: natively merged into llama.cpp as of ~today — so TTS may come free through the llama-server path we already run, no separate engine)

3d
https://github.com/VAST-AI-Research/SkinTokens?tab=MIT-1-ov-file
https://github.com/IgorAherne/TRELLIS.2-stableprojectorz

image
https://huggingface.co/krea/Krea-2-Turbo
https://huggingface.co/microsoft/Mage-Flow-Edit
https://huggingface.co/microsoft/Mage-Flow-Turbo
https://huggingface.co/microsoft/Mage-Flow

video
https://huggingface.co/Lightricks/LTX-2.3


text
https://huggingface.co/nvidia/Nemotron-Labs-Diffusion-VLM-8B
https://huggingface.co/microsoft/Fara1.5-4B
