# Project ownership and GitHub attribution

The project owner and maintainer is **dr-winner** on GitHub.

- Use `dr-winner` as the Git author and committer name for agent-assisted work.
- Use `132192045+dr-winner@users.noreply.github.com` as the Git author and committer email.
- Do not add agent or tool identities as authors, committers, co-authors, collaborators, maintainers, or reviewers.
- Do not add `Co-authored-by` trailers or agent attribution footers to commit messages or pull request descriptions.
- Before committing, verify the effective Git author and committer identities and inspect the final commit message for unwanted attribution.
- Perform authorized GitHub operations using the owner's `dr-winner` account.

These instructions apply to work on this project. Do not alter attribution on
unrelated third-party commits.

## Project context

- Read `docs/project-plan.md` and the relevant sections of `docs/build-guide.md` before implementation.
- The build guide is a proposal, not verified upstream documentation or executable instructions.
- Focus on tasks marked `[YOU]`: watcher, merchant wallet, and payment matcher. Coordinate changes to the lead's components through their documented interfaces.
- Verify changing network claims, tool versions, CLI flags, and library APIs against primary sources before relying on them.
- Keep wallet secrets and local databases out of source control. Treat viewing keys as sensitive payment-history access.
