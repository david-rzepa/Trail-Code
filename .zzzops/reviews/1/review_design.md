# Re-review: deterministic capture and cache fault injection

The revised design adds non-public injection boundaries for capture and caching, deterministic barriers for tests, and explicitly distinguishes genuine immutable point-in-time snapshots from observed-live captures. Production wiring remains separate and real-backend integration testing is retained. No new material finding in the change.
