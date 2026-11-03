# Charter

This house makes rules in `rules` mode.

- The operator enacts. The agent drafts a provision only as a proposal (`lampstand propose provision`), naming the
  occasion that calls for it, and never enacts one itself.
- A provision is in force once the operator adopts it (`lampstand adopt`); it then lives in `charter/provisions/`.
- Every adoption and every strike is recorded in `charter/record.md`.
- A budget cap rises only in a commit carrying a `Ruled-by: <operator>` trailer, and never in the same commit that
  grows the surface it caps.
