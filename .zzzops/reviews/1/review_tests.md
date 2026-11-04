# Commit-only test re-review

Approved. Three real-Git cases now run the production CLI with a self-tested Node filesystem read trap, exercising absolute links, chained links and symlink path components. They fail on attempted reads of the external target, repeat the analysis after changing its bytes, compare results, and check the sentinel remains intact after cleanup. This resolves the finding for Node filesystem access and adds a concrete external-content independence check. The trap does not intercept reads made by separate native processes; implementation review should still verify those boundaries.

At checkpoint 6f7bfa the full contract run passed in 24.0 seconds; the three added read-trap cases took 3.1 seconds separately. The safety suite still reports five expected failures because the committed-snapshot seam is not implemented. These costs are proportionate to the real Git and process isolation being checked.
