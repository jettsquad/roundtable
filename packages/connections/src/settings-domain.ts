/**
 * settings-domain.ts — what is true of the PERSON, not of any team.
 *
 * The first entry is the name you are called by at the table, and the reason
 * it needed a home outside a team record is what happened without one: it was
 * written as the literal 「主持人」 at both team-creation entry points, so it
 * could not be changed at all, and the field that carried it through the
 * whole system — domain, storage, every seat's prompt — had exactly one
 * possible value.
 *
 * User-level for the same reason the criteria library is: a name is a fact
 * about you, and one that could only be set inside a project would have to be
 * set again in the next project. The team record keeps its own field as an
 * OVERRIDE rather than as the source, which is also what makes this change
 * free of migration: a team saved before today has a value, it is still read,
 * and only new teams take their default from here.
 */
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

const userSettings = z.object({
  /**
   * What seats call you.
   *
   * Empty is not the same as unset and is refused at the service: a blank
   * name would reach a prompt as 「主持人：」 with nothing after it, which
   * reads to a model as a missing field rather than as a person.
   */
  hostDisplayName: z.string().optional(),
  updatedAt: z.number(),
});

export type UserSettingsRecord = z.infer<typeof userSettings>;

/** One user, one row. The key is fixed because there is only ever one. */
export const SETTINGS_KEY = "me";

export const SQUAD_SETTINGS_DOMAIN = defineDomain({
  name: "squad_settings",
  version: 1,
  tables: {
    /** Always exactly one row, under `SETTINGS_KEY`. */
    settings: domainTable<string, UserSettingsRecord>(userSettings),
  },
});
