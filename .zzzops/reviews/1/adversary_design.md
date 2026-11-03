# Adversary re-review

No material findings in the changed design. The new capture contract requires a point-in-time snapshot or reliable observation or serialization from before enumeration through sealing. It requires detection of edit-and-revert, additions and renames, event overflow and lost coverage, and rejects a capture when coherence cannot be established. The added adversarial tests exercise those cases and prohibit claiming a valid target after observation fails.

The implementation must demonstrate that its selected observation or serialization mechanism actually covers every relevant root and edit source; best-effort watcher behavior and before-and-after hashes do not satisfy this contract.
