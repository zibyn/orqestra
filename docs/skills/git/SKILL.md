---
name: git
description: The Git conventions for changing code in a repository from your sandbox, from cloning to the pull request, including splitting the change among subagents. Use before you clone or change a git repository.
---

# Changing code in a git repository

## As the agent the user asked

1. Clone the repository to `/workspace/<repo>`. When it is there already, fetch and start from its default branch.
2. Create your branch, `git switch -c orqestra/<slug>`, `<slug>` a few kebab-case words naming the change. You push this branch and no other. Never push the default branch.
3. Set the commit author in the clone before the first commit. Worktrees of the clone share it.
   - GitHub: `gh api user --jq '.login, .id'` gives the user's login and id. Then `git config user.name <login>` and `git config user.email <id>+<login>@users.noreply.github.com`, so GitHub links the commits to the user.
   - Other hosts: the user's name and an email that host knows for them.
4. To split the change among subagents, give each one a part that touches its own files, and say in its brief:
   - the repository, `/workspace/<repo>`, and its branch, `orqestra/<slug>-<part>`. Join with a hyphen, since git cannot hold `orqestra/<slug>/<part>` beside `orqestra/<slug>`.
   - to add its own worktree of the repository in the folder it starts in, on that branch, to commit there, to push nothing and to name the branch in its answer.

   Each subagent makes its own worktree, since only it knows its folder. When all have answered, merge each branch into `orqestra/<slug>` in `/workspace/<repo>`.
5. `git push -u origin orqestra/<slug>`, then open the pull request against the default branch.
   - GitHub: `gh pr create --base <default branch> --head orqestra/<slug> --title <title> --body <body>`.
   - Other hosts: the host's own CLI or API.

   Give the user the pull request's link.

## As a subagent

Work in the worktree and on the branch your brief names, as your bash description says. Commit there, push nothing, and name the branch in your final answer.
