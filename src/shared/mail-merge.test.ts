// The editor's unsaved edits and the chat's saved ones, merged against the
// copy the editor started from. What this pins: neither writer's change is
// lost when they touch different blocks or fields.
import { describe, expect, it } from "vitest";
import { contentPatch, mergeBlocks, mergeMail } from "./mail-merge";
import type { Block, Mail } from "./types";

const t = (id: string, md: string) => ({ id, type: "text", md }) as Block;
const base = [t("a", "A"), t("b", "B"), t("c", "C")];

describe("mergeBlocks", () => {
  it("the user typing in one block and the chat rewriting another keeps both", () => {
    const local = [t("a", "A, typed"), t("b", "B"), t("c", "C")];
    const remote = [t("a", "A"), t("b", "B, from chat"), t("c", "C")];
    expect(mergeBlocks(base, local, remote)).toEqual([t("a", "A, typed"), t("b", "B, from chat"), t("c", "C")]);
  });

  it("takes either side whole when only one changed", () => {
    const remote = [t("a", "new")];
    expect(mergeBlocks(base, base, remote)).toBe(remote);
    const local = [t("x", "mine")];
    expect(mergeBlocks(base, local, base)).toBe(local);
  });

  it("a block the editor added lands after its neighbour; one it removed stays removed", () => {
    const local = [t("a", "A"), t("n", "New"), t("c", "C")]; // added n, removed b
    const remote = [t("a", "A"), t("b", "B"), t("c", "C, from chat"), t("z", "Z from chat")];
    expect(mergeBlocks(base, local, remote)).toEqual([t("a", "A"), t("n", "New"), t("c", "C, from chat"), t("z", "Z from chat")]);
  });

  it("a block the user is editing survives the chat removing it", () => {
    const local = [t("a", "A"), t("b", "B, still typing"), t("c", "C")];
    const remote = [t("a", "A"), t("c", "C")];
    expect(mergeBlocks(base, local, remote)).toEqual([t("a", "A"), t("b", "B, still typing"), t("c", "C")]);
  });

  it("the same block edited on both sides keeps the user's typing", () => {
    expect(mergeBlocks(base, [t("a", "mine"), base[1], base[2]], [t("a", "chat"), base[1], base[2]])[0]).toEqual(t("a", "mine"));
  });
});

describe("mergeMail", () => {
  const mail = (over: Partial<Mail>): Mail => ({ id: 1, title: "T", preheader: "", blocks: base, design: null, design_mobile: null, status: "draft", rev: 1, ...over }) as Mail;

  it("fields: the editor's changed ones win, the rest and the send state come from remote", () => {
    const merged = mergeMail(mail({}), mail({ preheader: "mine" }), mail({ rev: 2, status: "scheduled", design: { colors: { primary: "#000000" } } as any }));
    expect(merged.preheader).toBe("mine");
    expect(merged.design).toEqual({ colors: { primary: "#000000" } });
    expect(merged.status).toBe("scheduled");
    expect(merged.rev).toBe(2);
  });

  it("contentPatch is what to save to turn remote into the merge", () => {
    const remote = mail({ rev: 2 });
    expect(contentPatch(remote, remote)).toEqual({});
    expect(contentPatch(remote, { ...remote, preheader: "x" })).toEqual({ preheader: "x" });
  });
});
