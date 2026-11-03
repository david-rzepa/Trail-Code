# Review of conservative two-snapshot analysis design

## Concurrency

The proposed worktree capture does not establish a coherent snapshot while capture itself is in progress. A file can be read, then changed while another file is read; or a relevant file can be added after enumeration, without either event being detected. The resulting fingerprint can describe a mixture that never existed as the requested worktree state, yet the design requires the consumer to analyze and validate that snapshot. The design assigns mutation observation only to the execution layer, which starts too late to detect this. Define a reliable point-in-time capture or observation/serialization covering enumeration and reads (including added paths and loss of observation), with invalidation or retry on change. Add tests that mutate a read file and add a relevant file during capture, including edit-and-revert. This maintains the spec's explicit captured working-tree identity and its no-false-verification requirement.

## Other lenses

Intent, simplicity, truth, adversary, rollout and experience: no additional material findings. The conservative fallback, separated report and cache namespaces serve the stated safety objective, and the owner chose direct work in the public fork. Exact schema and CLI details remain for design and review before publication, as the draft says.
