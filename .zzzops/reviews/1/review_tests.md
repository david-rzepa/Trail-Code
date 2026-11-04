# Parser recovery test review

Approved. Four independent real-CLI cases cover missing closing brace and parenthesis, each with the malformed file on either the source or target revision. They require an unbounded, revision- and path-specific gap, incomplete status and full-profile fallback. This directly tests that parser recovery cannot silently become conditional completeness. The subprocess and Git fixture cost is proportionate to the distinct revisions and syntax errors.

At checkpoint 0c71a1e the targeted four cases took 2.4 seconds and all failed on the missing gap. The full v2 suite took 8.5 seconds with six passing and four failing; the other three measured suites passed. These red observations reproduce the defect and do not show the fix working yet.
