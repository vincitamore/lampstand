"""Hermes imports the plugin directory as a package and calls its ``register(ctx)``."""

from .hosts.hermes.plugin import register

__all__ = ["register"]
