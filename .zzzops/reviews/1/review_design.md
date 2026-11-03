# Re-review of conservative two-snapshot analysis design

Resolved `review_design:1:1`. The revised design requires either a genuine point-in-time snapshot or reliable observation or serialization covering enumeration, reads and sealing; it explicitly detects relevant additions, deletions, renames, edit-and-revert and observation loss. Capture is invalidated or fails when coherence cannot be guaranteed, with tests for the relevant mutations and failure modes. This addresses the identified risk. No new material finding in the changed design.
