import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React, { StrictMode } from "react";
import { setupDomGlobals } from "@/test-setup";
import { I18nProvider } from "@/contexts/I18nContext";
import { StrategySelector } from "./StrategySelector";

setupDomGlobals();

function createJsonResponse<T>(payload: T): Response {
  return new Response(JSON.stringify({ success: true, data: payload }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderStrategySelector() {
  return render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(StrategySelector),
    ),
  );
}

describe("StrategySelector load and retry flow", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setupDomGlobals();
    localStorage.clear();
  });

  afterEach(() => {
    // This repo's `node --test` runner doesn't auto-wire testing-library's
    // cleanup (it only self-registers under jest/vitest globals), so a
    // rendered tree from one test otherwise leaks into the next test's DOM.
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("shows the load-error banner and retries the fetch", async () => {
    let callCount = 0;

    globalThis.fetch = (async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new TypeError("network down");
      }
      return createJsonResponse({ strategy: "balanced" });
    }) as typeof fetch;

    const view = renderStrategySelector();

    await waitFor(() => {
      assert.ok(view.getByRole("alert"));
    });

    fireEvent.click(view.getByRole("button", { name: /retry/i }));

    await waitFor(() => {
      assert.equal(callCount, 2);
    });

    await waitFor(() => {
      // "Balanced" also appears in the comparison table, so scope to the
      // strategy-card heading to avoid an ambiguous multi-match.
      assert.ok(view.getByRole("heading", { level: 2, name: /balanced/i }));
    });
  });

  it("ignores a stale response from an aborted mount effect (StrictMode double-invoke)", async () => {
    // Regression test for the `if (controller.signal.aborted) return;` guard
    // before the LOAD_SUCCESS dispatch: React 18 StrictMode runs the mount
    // effect, cleans it up (aborting its controller), and runs it again —
    // synchronously, before either fetch can resolve — which is the same
    // "controller aborted, fetch still in flight" shape as an unmount or a
    // retry. Because the component stays mounted throughout, the outcome is
    // observable: without the guard, the first (aborted) effect's late
    // response still overwrites the state the second effect already set.
    let callCount = 0;
    let resolveFirstFetch!: (value: Response) => void;

    globalThis.fetch = (async () => {
      callCount += 1;
      if (callCount === 1) {
        // First effect run's fetch: held open so its abort survives past
        // StrictMode's synchronous cleanup, then resolved late below.
        return new Promise<Response>((resolve) => {
          resolveFirstFetch = resolve;
        });
      }
      // Second (post-remount) effect run's fetch resolves immediately.
      return createJsonResponse({ strategy: "balanced" });
    }) as typeof fetch;

    const view = render(
      React.createElement(
        StrictMode,
        null,
        React.createElement(I18nProvider, null, React.createElement(StrategySelector)),
      ),
    );

    assert.equal(callCount, 2, "StrictMode should have started and aborted the first effect's fetch");

    await waitFor(() => {
      assert.ok(view.getByRole("article", { name: /balanced strategy \(current\)/i }));
    });

    // Resolve the stale, aborted first fetch with a *different* strategy.
    resolveFirstFetch(createJsonResponse({ strategy: "conservative" }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(
      view.getByRole("article", { name: /balanced strategy \(current\)/i }),
      "the stale aborted fetch must not overwrite the current strategy",
    );
  });
});
