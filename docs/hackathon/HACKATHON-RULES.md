# Rules that affect Polypus Keys

Source: [`HACKATHON.md`](HACKATHON.md), copied from https://nearhackathon.com/HACKATHON.md on 2026-11-05. Re-read the live file before submitting.

- **Deadline:** 2026-11-14T23:59:00Z. The repository must be **public** by then, and judges can't open a private one. Judging runs 16–18 Nov.
- **One submission, no edits.** Mistakes are fixed through https://nearhackathon.com/request-changes, never by resubmitting: the same repository gets a 409.
- **Prior work (Q-001–Q-005).** Code written from the announcement on **2026-10-19** counts. An existing product on another chain is allowed, but **only the NEAR integration built in the window is judged**, and it must be disclosed in the README. For a new feature on an existing project, separate it with a branch or with `pre-hackathon` / `hackathon-submission` tags, and link the diff from the README.
  - Every Polypus protocol commit is dated 2026-11-03, inside the window. We still disclose the protocol as the baseline and tag it: `pre-hackathon` = `babc85b` (last protocol commit before the Keys work).
- **Libraries and AI code are allowed (Q-005).** List them in the README.
- **Intents has no testnet (Q-007).** Use mainnet, separate dev accounts, tiny amounts, and `dry: true` quotes. A 1Click JWT is optional; without one there's an extra fee (Q-006).
- **Testnet-only projects are eligible (Q-010).** Use mainnet only where the integration is mainnet-only. No integration is mandatory (Q-011).
- **Demo (Q-012).** A local-only demo is OK, but the X post then needs a **video**: screenshots aren't enough when judges can't open the demo. A hosted demo is a plus; keep it up until at least 2026-11-18, ideally 2026-11-25.
- **License (Q-014).** Add a LICENSE file (MIT is fine), and the repo must stay public through judging.
- **AI screening (Q-017).** Claude Code and Codex check that the project runs and does what the README says, so the README needs "do X, see Y" steps and no marketing.
- **Demo post.** Built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon (optionally @NearLegion and @NearBuilders), attach a video. The human posts it.
- **Things only the human does:** send the submission (POST /api/applications, after confirming the payload), post on X, make the repo public or push, sign mainnet transactions or spend tokens, and provide the payout `*.near` account. The agent never invents that account.
- **Previous judging criteria:** technical implementation, design, impact, originality and sustainability.
