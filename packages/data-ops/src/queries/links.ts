import { getDb } from "@/db/database";
import { links } from "@/drizzle-out/schema";
import {
  CreateLinkSchemaType,
  destinationsSchema,
  DestinationsSchemaType,
  linkSchema,
} from "@/zod/links";
import { and, desc, eq, gt } from "drizzle-orm";
import { nanoid } from "nanoid";

export const createLink = async (
  data: CreateLinkSchemaType & { accountId: string },
) => {
  const db = getDb();
  const id = nanoid(10);
  await db.insert(links).values({
    linkId: id,
    accountId: data.accountId,
    name: data.name,
    destinations: JSON.stringify(data.destinations),
  });
  return id;
};
export const getLinks = async (accountId: string, createdBefore?: string) => {
  const db = getDb();
  const conditions = [eq(links.accountId, accountId)];
  if (createdBefore) {
    conditions.push(gt(links.created, createdBefore));
  }
  const result = await db
    .select({
      linkId: links.linkId,
      name: links.name,
      destinations: links.destinations,
      created: links.created,
    })
    .from(links)
    .where(and(...conditions))
    .orderBy(desc(links.created))
    .limit(25);
  return result.map((link) => ({
    ...link,
    lastSixHours: Array.from({ length: 6 }, () =>
      Math.floor(Math.random() * 100),
    ),
    linkClicks: 6,
    destinations: Object.keys(JSON.parse(link.destinations as string)).length,
  }));
};
export const updateLink = async (linkId: string, name: string) => {
  const db = getDb();
  await db
    .update(links)
    .set({
      name,
      updated: new Date().toISOString(),
    })
    .where(eq(links.linkId, linkId));
};
export const getLink = async (linkId: string) => {
  const db = getDb();
  const result = await db
    .select()
    .from(links)
    .where(eq(links.linkId, linkId))
    .limit(1);
  const link = result[0];
  const parsedLink = linkSchema.safeParse(link);
  if (!parsedLink.success) {
    console.log("error while parsing link");
    throw new Error("BAD_REQUEST Error parsing link");
  }
  return parsedLink.data;
};
export const updateLinkDestinations = async (
  linkId: string,
  destinations: DestinationsSchemaType,
) => {
  const destinationsParsed = destinationsSchema.parse(destinations);
  const db = getDb();
  await db
    .update(links)
    .set({
      destinations: JSON.stringify(destinationsParsed),
      updated: new Date().toISOString(),
    })
    .where(eq(links.linkId, linkId));
};
