"""WHICH ACCELERATOR TO USE — one answer, in one place.

The user: "we target all major OS and all major hardware eventually in a modular
fashion such that we have a boatload of alternatives that we know of and can get
working quick to get max out of the box no setup fast inference for any hardware
on any OS."

The 3D workers grew up on this Mac and it shows: some of them ask
`torch.backends.mps.is_available()`, some hardcode `torch.device("mps")`, and
each one guards its cache-empty with its own `hasattr(torch, "mps")`. Every one
of those is a place a CUDA machine falls off the path for no reason — the maths
is identical, only the device string differs.

WHY THE ORDER IS CUDA FIRST. Not a preference for NVIDIA: it is that a machine
with a discrete GPU has it *in addition* to everything else, so "the best device
present" is unambiguous there, while a Mac has exactly one answer. ROCm reports
itself as CUDA through PyTorch's HIP build, so it is covered by the same branch
without naming it.

WHAT THIS IS NOT. It does not decide precision, attention implementation, or
memory strategy — those genuinely differ per backend (fp32 is a CORRECTNESS
requirement for SkinTokens on MPS; MPS has no float64 at all). Those decisions
stay at their call sites with their reasons. This answers only "where do the
tensors live".
"""

from __future__ import annotations


def pick_device(prefer: str | None = None) -> str:
    """The best device present, as a torch device string.

    `prefer` short-circuits when the caller was told explicitly (a `--device`
    flag), except for 'auto', which means "you decide".
    """
    import torch

    if prefer not in (None, "", "auto"):
        return prefer
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def empty_cache(device: str | None = None) -> None:
    """Hand freed memory back to the driver, on whichever backend this is.

    A no-op on CPU, and safe to call on a build that has neither backend — the
    workers call it after dropping multi-gigabyte models, and a missing
    attribute there would turn a memory optimisation into a crash.
    """
    import torch

    dev = device or pick_device()
    if dev.startswith("cuda") and torch.cuda.is_available():
        torch.cuda.empty_cache()
        return
    if dev.startswith("mps") and getattr(torch, "mps", None) is not None:
        torch.mps.empty_cache()
