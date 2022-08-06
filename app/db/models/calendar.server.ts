import { dateToDatabaseTimestamp } from "~/utils/dates";
import { sql } from "../sql";
import type {
  CalendarEvent,
  CalendarEventDate,
  User,
  Badge,
  CalendarEventTag,
  CalendarEventBadge,
  CalendarEventWinner,
} from "../types";

const createStm = sql.prepare(`
  insert into "CalendarEvent" (
    "name",
    "authorId",
    "tags",
    "description",
    "discordInviteCode",
    "bracketUrl"
  ) values (
    $name,
    $authorId,
    $tags,
    $description,
    $discordInviteCode,
    $bracketUrl
  ) returning *
`);

const updateStm = sql.prepare(`
  update "CalendarEvent" set
    "name" = $name,
    "tags" = $tags,
    "description" = $description,
    "discordInviteCode" = $discordInviteCode,
    "bracketUrl" = $bracketUrl
  where "id" = $eventId
`);

const createDateStm = sql.prepare(`
  insert into "CalendarEventDate" (
    "eventId",
    "startTime"
  )
  values (
    $eventId,
    $startTime
  )
`);

const deleteDatesByEventIdStm = sql.prepare(`
  delete from "CalendarEventDate"
  where "eventId" = $eventId
`);

const createBadgeStm = sql.prepare(`
  insert into "CalendarEventBadge" (
    "eventId",
    "badgeId"
  )
  values (
    $eventId,
    $badgeId
  )
`);

const deleteBadgesByEventIdStm = sql.prepare(`
  delete from "CalendarEventBadge"
  where "eventId" = $eventId
`);

export type CreateArgs = Pick<
  CalendarEvent,
  | "name"
  | "authorId"
  | "tags"
  | "description"
  | "discordInviteCode"
  | "bracketUrl"
> & {
  startTimes: Array<CalendarEventDate["startTime"]>;
  badges: Array<CalendarEventBadge["badgeId"]>;
};
export const create = sql.transaction(
  ({ startTimes, badges, ...calendarEventArgs }: CreateArgs) => {
    const createdEvent = createStm.get(calendarEventArgs) as CalendarEvent;

    for (const startTime of startTimes) {
      createDateStm.run({
        eventId: createdEvent.id,
        startTime,
      });
    }

    for (const badgeId of badges) {
      createBadgeStm.run({
        eventId: createdEvent.id,
        badgeId,
      });
    }

    return createdEvent.id;
  }
);

export const update = sql.transaction(
  ({
    startTimes,
    badges,
    eventId,
    ...calendarEventArgs
  }: Omit<CreateArgs, "authorId"> & { eventId: CalendarEvent["id"] }) => {
    updateStm.run({ ...calendarEventArgs, eventId });

    deleteDatesByEventIdStm.run({ eventId });
    for (const startTime of startTimes) {
      createDateStm.run({
        eventId,
        startTime,
      });
    }

    deleteBadgesByEventIdStm.run({ eventId });
    for (const badgeId of badges) {
      createBadgeStm.run({
        eventId,
        badgeId,
      });
    }
  }
);

const updateCalendarEventParticipantsCountStm = sql.prepare(`
  update "CalendarEvent" 
    set "participantCount" = $participantCount
    where "id" = $eventId
`);

const deleteCalendarEventWinnersByEventIdStm = sql.prepare(`
  delete from "CalendarEventWinner"
    where "eventId" = $eventId
`);

const insertCalendarEventWinnerStm = sql.prepare(`
  insert into "CalendarEventWinner" (
    "eventId",
    "teamName",
    "placement",
    "userId",
    "name"
  ) values (
    $eventId,
    $teamName,
    $placement,
    $userId,
    $name
  )
`);
export const upsertReportedScores = sql.transaction(
  ({
    eventId,
    participantCount,
    winners,
  }: {
    eventId: CalendarEvent["id"];
    participantCount: CalendarEvent["participantCount"];
    winners: Array<
      Pick<CalendarEventWinner, "teamName" | "placement" | "userId" | "name">
    >;
  }) => {
    updateCalendarEventParticipantsCountStm.run({ eventId, participantCount });
    deleteCalendarEventWinnersByEventIdStm.run({ eventId });

    for (const winner of winners) {
      insertCalendarEventWinnerStm.run({ ...winner, eventId });
    }
  }
);

const findWinnersByEventIdStm = sql.prepare(`
  select 
    "teamName",
    "placement",
    "userId",
    "name"
  from "CalendarEventWinner"
  where "eventId" = $eventId
  order by "placement" asc
`);

export function findWinnersByEventId(eventId: CalendarEvent["id"]) {
  const rows = findWinnersByEventIdStm.all({ eventId }) as Array<
    Pick<CalendarEventWinner, "teamName" | "placement" | "userId" | "name">
  >;

  const result: Array<{
    teamName: CalendarEventWinner["teamName"];
    placement: CalendarEventWinner["placement"];
    players: Array<string | { id: number }>;
  }> = [];

  for (const row of rows) {
    const team = result.find((team) => team.teamName === row.teamName);
    const player = row.name ?? { id: row.userId! };

    if (team) {
      team.players.push(player);
    } else {
      result.push({
        teamName: row.teamName,
        placement: row.placement,
        players: [player],
      });
    }
  }

  return result;
}

const findAllBetweenTwoTimestampsStm = sql.prepare(`
  select
    "CalendarEvent"."name",
    "CalendarEvent"."discordUrl",
    "CalendarEvent"."bracketUrl",
    "CalendarEvent"."tags",
    "CalendarEventDate"."id" as "eventDateId",
    "CalendarEventDate"."eventId",
    "CalendarEventDate"."startTime",
    "User"."discordName",
    "User"."discordDiscriminator",
    "CalendarEventRanks"."nthAppearance",
    exists (select 1 
      from "CalendarEventBadge" 
      where "CalendarEventBadge"."eventId" = "CalendarEventDate"."eventId"
    ) as "hasBadge"
    from "CalendarEvent"
    join "CalendarEventDate" on "CalendarEvent"."id" = "CalendarEventDate"."eventId"
    join "User" on "CalendarEvent"."authorId" = "User"."id"
    join (
      select 
        "id", 
        "eventId", 
        "startTime", 
        rank() over(partition by "eventId" order by "startTime" asc) "nthAppearance" 
      from "CalendarEventDate"
    ) "CalendarEventRanks" on "CalendarEventDate"."id" = CalendarEventRanks."id"
    where "CalendarEventDate"."startTime" between $startTime and $endTime
    order by "CalendarEventDate"."startTime" asc
`);

function addTagArray<
  T extends { hasBadge: number; tags?: CalendarEvent["tags"] }
>(arg: T) {
  const { hasBadge, ...row } = arg;
  const tags = (row.tags ? row.tags.split(",") : []) as Array<CalendarEventTag>;

  if (hasBadge) tags.unshift("BADGE");

  return { ...row, tags };
}

export function findAllBetweenTwoTimestamps({
  startTime,
  endTime,
}: {
  startTime: Date;
  endTime: Date;
}) {
  const rows = findAllBetweenTwoTimestampsStm.all({
    startTime: dateToDatabaseTimestamp(startTime),
    endTime: dateToDatabaseTimestamp(endTime),
  }) as Array<
    Pick<CalendarEvent, "name" | "discordUrl" | "bracketUrl" | "tags"> &
      Pick<CalendarEventDate, "eventId" | "startTime"> & {
        eventDateId: CalendarEventDate["id"];
      } & Pick<User, "discordName" | "discordDiscriminator"> & {
        nthAppearance: number;
      } & { hasBadge: number }
  >;

  return rows.map(addTagArray);
}

const findByIdStm = sql.prepare(`
  select
    "CalendarEvent"."name",
    "CalendarEvent"."description",
    "CalendarEvent"."discordInviteCode",
    "CalendarEvent"."discordUrl",
    "CalendarEvent"."bracketUrl",
    "CalendarEvent"."tags",
    "CalendarEvent"."participantCount",
    "User"."id" as "authorId",
    exists (select 1 
      from "CalendarEventBadge" 
      where "CalendarEventBadge"."eventId" = "CalendarEventDate"."eventId"
    ) as "hasBadge",
    "CalendarEventDate"."startTime",
    "CalendarEventDate"."eventId",
    "User"."discordName",
    "User"."discordDiscriminator",
    "User"."discordId",
    "User"."discordAvatar"
  from "CalendarEvent"
  join "CalendarEventDate" on "CalendarEvent"."id" = "CalendarEventDate"."eventId"
  join "User" on "CalendarEvent"."authorId" = "User"."id"
  where "CalendarEvent"."id" = $id
  order by "CalendarEventDate"."startTime" asc
`);

export function findById(id: CalendarEvent["id"]) {
  const [firstRow, ...rest] = findByIdStm.all({ id }) as Array<
    Pick<
      CalendarEvent,
      | "name"
      | "description"
      | "discordUrl"
      | "discordInviteCode"
      | "bracketUrl"
      | "tags"
      | "authorId"
      | "participantCount"
    > &
      Pick<CalendarEventDate, "startTime" | "eventId"> &
      Pick<
        User,
        "discordName" | "discordDiscriminator" | "discordId" | "discordAvatar"
      > & { hasBadge: number }
  >;

  if (!firstRow) return null;

  return addTagArray({
    ...firstRow,
    startTimes: [firstRow, ...rest].map((row) => row.startTime),
    startTime: undefined,
  });
}

const startTimesOfRangeStm = sql.prepare(`
  select
    "CalendarEventDate"."startTime"
  from "CalendarEventDate"
  where "CalendarEventDate"."startTime" between $startTime and $endTime
`);

export function startTimesOfRange({
  startTime,
  endTime,
}: {
  startTime: Date;
  endTime: Date;
}) {
  return (
    startTimesOfRangeStm.all({
      startTime: dateToDatabaseTimestamp(startTime),
      endTime: dateToDatabaseTimestamp(endTime),
    }) as Array<Pick<CalendarEventDate, "startTime">>
  ).map(({ startTime }) => startTime);
}

const findBadgesByIdStm = sql.prepare(`
  select "Badge"."id", "Badge"."code", "Badge"."hue", "Badge"."displayName"
  from "CalendarEventBadge"
  join "Badge" on "CalendarEventBadge"."badgeId" = "Badge"."id"
  where "CalendarEventBadge"."eventId" = $eventId
`);

export function findBadgesById(eventId: CalendarEvent["id"]) {
  return findBadgesByIdStm.all({ eventId }) as Array<
    Pick<Badge, "id" | "code" | "hue" | "displayName">
  >;
}
