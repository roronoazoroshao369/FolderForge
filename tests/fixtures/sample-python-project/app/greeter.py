"""Greeting helpers used as known-content targets in FolderForge tests.

Symbol names (``greet``, ``Greeter``, ``DEFAULT_NAME``) are asserted on, so
keep them stable.
"""

DEFAULT_NAME = "world"


def greet(name: str = DEFAULT_NAME) -> str:
    """Return a friendly greeting."""
    return f"Hello, {name}!"


class Greeter:
    def __init__(self, name: str = DEFAULT_NAME) -> None:
        self.name = name

    def say(self) -> str:
        return greet(self.name)
