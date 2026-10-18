// Server only: these files hold customer PII and must not be bundled into the browser.
import { z } from "zod";
import labelledRaw from "../data/support_tickets_100_labelled.json";
import unlabelledRaw from "../data/support_tickets_500.json";
import { Category, Priority, type Dataset } from "./schemas";

export const Ticket = z.object({
  ticket_id: z.string(),
  created_at: z.string(),
  channel: z.string(),
  language: z.string(),
  customer_name: z.string(),
  customer_email: z.string(),
  customer_plan: z.string(),
  subject: z.string(),
  body: z.string(),
});
export type Ticket = z.infer<typeof Ticket>;

export const LabelledTicket = Ticket.extend({
  category: Category,
  priority: Priority,
  needs_human_review: z.boolean(),
  tags: z.string(),
  label_notes: z.string(),
});
export type LabelledTicket = z.infer<typeof LabelledTicket>;

// Validated once, on first use. A bad file fails loudly here instead of producing odd scores later.
let cache: { labelled_100: LabelledTicket[]; unlabelled_500: Ticket[] } | null = null;

function load() {
  cache ??= {
    labelled_100: z.array(LabelledTicket).parse(labelledRaw),
    unlabelled_500: z.array(Ticket).parse(unlabelledRaw),
  };
  return cache;
}

export function getDataset(dataset: Dataset): Ticket[] | LabelledTicket[] {
  return load()[dataset];
}

export function isLabelled(ticket: Ticket): ticket is LabelledTicket {
  return "category" in ticket;
}

// Uniform random sample without repeats: Fisher–Yates shuffle a copy, then take the first n.
export function sampleTickets<T>(list: readonly T[], n: number): T[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
