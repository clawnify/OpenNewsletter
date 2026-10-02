import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "./csv";
import { guessColumns, guessStatus, mapRows, parseDate, statusFromFileName, statusValues } from "./import-map";

const map = (csv: string, file: ReturnType<typeof statusFromFileName> = null) => {
  const [header, ...rows] = parseCsv(csv);
  const cols = guessColumns(header);
  return { cols, ...mapRows(rows, cols, { file, values: {} }) };
};

describe("parseCsv", () => {
  it("handles quotes, line breaks in quotes, CRLF, a BOM and semicolons", () => {
    expect(parseCsv('﻿a;b\r\n"x;1";"say ""hi""\nthere"\r\n\r\n')).toEqual([["a", "b"], ["x;1", 'say "hi"\nthere']]);
  });
  it("round-trips our own export, formula guard included", () => {
    const text = toCsv(["email", "first_name"], [["a@x.io", "=cmd"], ["b@x.io", 'O"Neil, Jr']]);
    expect(text).toContain("'=cmd");
    const { rows } = map(text);
    expect(rows.map((r) => r.first_name)).toEqual(["=cmd", 'O"Neil, Jr']);
  });
});

describe("column guesses", () => {
  it("reads Ghost's members export (one name column, a boolean for email consent)", () => {
    const { rows } = map(
      "id,email,name,note,subscribed_to_emails,complimentary_plan,stripe_customer_id,created_at,deleted_at,labels,tiers\n" +
        "1,ann@x.io,Ann Lee Smith,,true,false,,2024-03-01T09:30:00.000Z,,,\n" +
        "2,bob@x.io,Bob,,false,false,,2024-03-02T09:30:00.000Z,,,\n",
    );
    expect(rows).toEqual([
      { email: "ann@x.io", first_name: "Ann", last_name: "Lee Smith", status: "subscribed", opted_in_at: "2024-03-01T09:30:00.000Z" },
      { email: "bob@x.io", first_name: "Bob", last_name: "", status: "unsubscribed", opted_in_at: "2024-03-02T09:30:00.000Z" },
    ]);
  });

  it("reads Buttondown's subscriber_type values and prefers the subscription date", () => {
    const { rows, cols } = map(
      "id,secondary_id,email,notes,subscriber_type,referrer_url,creation_date,subscription_date,unsubscription_date\n" +
        "1,1,a@x.io,,regular,,2024-01-01,2024-01-05,\n2,2,b@x.io,,undeliverable,,2024-01-01,,\n3,3,c@x.io,,unactivated,,2024-01-01,,\n",
    );
    expect(cols.opted_in_at).toBe(7);
    expect(rows.map((r) => r.status)).toEqual(["subscribed", "bounced", "pending"]);
    expect(rows[0].opted_in_at).toBe("2024-01-05T00:00:00.000Z");
  });

  it("takes the status from a Mailchimp file name, and skips the non-subscribed file", () => {
    expect(statusFromFileName("unsubscribed_members_export_3f2a.csv")).toBe("unsubscribed");
    expect(statusFromFileName("cleaned_members_export_3f2a.csv")).toBe("bounced");
    expect(statusFromFileName("nonsubscribed_members_export_3f2a.csv")).toBe("skip");
    expect(statusFromFileName("subscribed_members_export_3f2a.csv")).toBe("subscribed");
    expect(statusFromFileName("my-list.csv")).toBeNull();
    const { rows, skipped } = map("Email Address,First Name,Last Name,OPTIN_TIME\na@x.io,A,B,2023-04-01 10:00:00\n", "skip");
    expect([rows.length, skipped]).toEqual([0, 1]);
    const sub = map("Email Address,First Name,Last Name,OPTIN_TIME\na@x.io,A,B,2023-04-01 10:00:00\n", "subscribed");
    expect(sub.rows[0]).toMatchObject({ first_name: "A", last_name: "B", opted_in_at: "2023-04-01T10:00:00.000Z" });
  });

  it("carries our own export's per-row consent record", () => {
    const { rows } = map("email,first_name,last_name,status,consent_source,consent_at,consent_evidence\na@x.io,,,subscribed,signup_form,2025-01-01 00:00:00,Confirmed by clicking the link\n");
    expect(rows[0]).toMatchObject({ status: "subscribed", evidence: "Confirmed by clicking the link", opted_in_at: "2025-01-01T00:00:00.000Z" });
  });
});

describe("status guesses", () => {
  it("never reads unsubscribed as subscribed, and leaves unknown values pending", () => {
    expect(["Unsubscribed", "Complained", "Cold", "Needs approval", "who knows"].map(guessStatus)).toEqual([
      "unsubscribed", "bounced", "subscribed", "pending", "pending",
    ]);
  });
  it("lists a column's values most common first, for the operator to confirm", () => {
    expect(statusValues([["a"], ["b"], ["a"]], 0)).toEqual([{ value: "a", count: 2 }, { value: "b", count: 1 }]);
  });
  it("lets an operator's choice for a value win over the guess", () => {
    const [header, ...rows] = parseCsv("email,status\na@x.io,weird\n");
    expect(mapRows(rows, guessColumns(header), { file: null, values: { weird: "unsubscribed" } }).rows[0].status).toBe("unsubscribed");
  });
});

describe("parseDate", () => {
  it("reads zone-less date-times as UTC and rejects junk", () => {
    expect(parseDate("2024-03-01 09:30")).toBe("2024-03-01T09:30:00.000Z");
    expect(parseDate("not a date")).toBeNull();
    expect(parseDate("")).toBeNull();
  });
});
