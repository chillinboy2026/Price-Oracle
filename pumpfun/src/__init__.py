"""An agent-scored pump.fun trading pipeline.

Nine stages, arranged so that cheap code filters run before expensive model
calls: only a fraction of a percent of the launch stream ever reaches the
strong model.
"""

__version__ = "1.0.0"
