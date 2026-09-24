"""The skeleton's contract: the package imports and says what version it is."""

import bobble_train


def test_package_imports() -> None:
    assert bobble_train.__version__ == "0.0.0"
