# dsh-auto-context (standalone)

Auto decision plugin for dsh. With your own API key set it calls `jev-1.13-free` directly for structured decisions; the plugin implements those decisions through native dsh sessions, tools and subagents. The main agent and children use the configured execution model. The plugin contains no agent execution runtime and no external gateway. See [README.md](README.md) for the full Chinese documentation.

Requires dsh `0.1.5-rc.1` or `0.2.x` (verified on `0.2.0-rc.2`).

## Upgrading from 0.5.x

From 0.6.0 the plugin is renamed `dsh-auto-context`: rename the `dsh-auto` entry in your profile overrides to `dsh-auto-context`, uninstall the old package (`dsh plugin --profile auto remove dsh-auto`) and install the new one. The storage domain stays `dsh_auto`, so existing policy data keeps working.

## Settings page and composer chip (new in 0.6.0)

The plugin ships a browser page: **Plugins → dsh-auto-context → Configure** edits the mode, Jev API key, Jev model, decision budget, subagent and context fields; routes, strategy and weights remain in YAML. Once a session has been touched by Auto, a small statistics chip appears at the right of the composer: a ring shows context pressure, the numbers are `decisions/budget · running subagents`, and hovering opens a card with mode, decision progress, subagents, context usage, compactions with tokens saved, and the last route.

## Install

The plugin talks to Jev directly: with `apiKey` set it uses the direct Jev endpoint, and with no `apiKey` it runs in native mode.

```bash
# Create a profile, then install from GitHub or npm
dsh --profile auto --from-default-profile headless --dump-config >/dev/null
dsh plugin --profile auto add github:ZhiweiWei-NAMI/dsh-auto-context#v0.6.0
# or the npm package dsh-auto-context
dsh plugin --profile auto add dsh-auto-context
```

Give `dsh-auto-context` a minimal config in the profile's own `cordis.patch.yml`. Get `apiKey` from the workspace API Keys page at <https://opencode.ai>:

```yaml
- id: dsh-auto-context
  config:
    apiKey: <your opencode workspace key>
    routes:
      - id: general
        label: General implementation
        model: deepseek-v4.1-flash
        description: Implement and modify code
        efforts: [high]
      - id: review
        label: Independent review
        model: deepseek-v4.1-flash
        description: Review implementation and test evidence
        efforts: [high]
```

`routes` lists the allowed roles, models and efforts; the execution model connection still comes from `settings.yaml`. When `routes` is empty the plugin uses the session's current native model as the single default route. Without `strategy` the plugin uses mode `automatic` with default weights `{quality: 0.8, latency: 0.5, usage: 0.5, cache: 0.8}`; `mode: single` / `native` fix single-agent and native compaction respectively. `apiKey` is declared as a secret and is not written to logs or record files.

With no `apiKey` the plugin calls no network service: the session runs in native mode (same path as `strategy.mode: native`) and records one `policy_snapshot` with `reason: 'no-api-key'`. It does not throw.

## Upgrading from 0.4.x

Rename `magpie-auto` to `dsh-auto-context` in your profile overrides; the `endpoint` field is gone and should be removed.
