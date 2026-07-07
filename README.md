# Moke

Moke is a lightweight agent for browsing the web.

It is built around a simple idea:

```text
LLM + tools + inner browser
```

The LLM understands the task, tools provide local and external capabilities, and the inner browser opens real pages that the agent can inspect and operate.

## Why

There are already many chatbots, agents, and AI browsers. Most of them are powerful, but many browsing features still feel limited: the browser tab becomes text, and the AI mostly reads or summarizes it.

Reading is useful, but browsing is not only reading. Real web use often means opening links, clicking buttons, scrolling pages, filling forms, comparing pages, waiting for changes, and taking screenshots.

Those actions are not especially complicated. Moke is an attempt to make a small agent that can do them directly.

## Positioning

Moke is not trying to be a heavy general-purpose agent.

It is closer to a small personal vehicle for information surfing:

- cheap to run
- simple to understand
- good enough for daily use
- easy to modify
- not overloaded with features

As token prices keep falling, lightweight agents become more practical for everyday information work. In my own tests with a low-cost model, normal daily browsing could cost only a few cents. For this kind of tool, electricity is the cost, and tokens are the electricity.

## What It Does

Moke focuses on practical browsing and tool use:

- open pages in an inner browser
- read page content and page structure
- click, type, scroll, and upload files
- take snapshots and screenshots
- call local tools
- connect to local LLM providers
- connect to MCP servers
- use skills for reusable workflows

The goal is not to support every possible agent feature. The goal is to keep the loop short: ask, browse, operate, summarize, continue.

## Why Not Just Browser AI

Modern browsers are adding AI features, but many of them still treat the page mostly as readable text.

Moke takes a slightly different view: if an AI assistant is helping with the web, it should be able to operate the web. It should read pages, but it should also click, scroll, fill, switch pages, and confirm what changed.

That is why the inner browser is part of the core design rather than an optional extra.

## Current Status

Moke is still early. The experience is not as polished as mature tools like Codex, and many details are still being improved.

But for everyday information browsing, page reading, simple web operations, local model access, and MCP/tool integration, it is already useful enough for personal use.

The direction is intentionally modest: make it cheap, make it simple, make it usable, then improve it step by step.

## One Line

Moke is a lightweight web-browsing agent: cheap enough for daily use, simple enough to own, and capable of both reading and operating the web.
