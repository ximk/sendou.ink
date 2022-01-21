import type { Prisma } from ".prisma/client";
import {
  TOURNAMENT_CHECK_IN_CLOSING_MINUTES_FROM_START,
  TOURNAMENT_TEAM_ROSTER_MAX_SIZE,
} from "~/constants";
import { MapListIds, tournamentRoundsForDB } from "~/core/tournament/bracket";
import { captainOfTeam, sortTeamsBySeed } from "~/core/tournament/utils";
import * as Tournament from "~/models/Tournament.server";
import * as TournamentTeam from "~/models/TournamentTeam.server";
import * as TournamentTeamMember from "~/models/TournamentTeamMember.server";
import * as TrustRelationship from "~/models/TrustRelationship.server";
import { Serialized, Unpacked } from "~/utils";
import { db } from "~/utils/db.server";
import { isTournamentAdmin } from "~/validators/tournament";

export type FindTournamentByNameForUrlI = Serialized<
  Prisma.PromiseReturnType<typeof findTournamentByNameForUrl>
>;

export async function findTournamentByNameForUrl({
  organizationNameForUrl,
  tournamentNameForUrl,
}: {
  organizationNameForUrl: string;
  tournamentNameForUrl: string;
}) {
  const result = await Tournament.findByNameForUrl({
    tournamentNameForUrl,
    organizationNameForUrl,
  });

  if (!result) throw new Response("No tournament found", { status: 404 });

  result.teams.sort(sortTeamsBySeed(result.seeds));

  result.organizer.twitter = twitterToUrl(result.organizer.twitter);
  result.organizer.discordInvite = discordInviteToUrl(
    result.organizer.discordInvite
  );
  const resultWithCSSProperties = addCSSProperties(result);

  return resultWithCSSProperties;
}

function twitterToUrl(twitter: string | null) {
  if (!twitter) return twitter;

  return `https://twitter.com/${twitter}`;
}

function discordInviteToUrl(discordInvite: string) {
  return `https://discord.com/invite/${discordInvite}`;
}

function addCSSProperties(
  tournament: Unpacked<NonNullable<Tournament.FindByNameForUrl>>
) {
  const { bannerTextHSLArgs, ...rest } = tournament;

  return {
    ...rest,
    CSSProperties: {
      text: `hsl(${bannerTextHSLArgs})`,
      textTransparent: `hsla(${bannerTextHSLArgs}, 0.3)`,
    },
  };
}

export type OwnTeamWithInviteCodeI = Serialized<
  Prisma.PromiseReturnType<typeof ownTeamWithInviteCode>
>;

export async function ownTeamWithInviteCode({
  organizationNameForUrl,
  tournamentNameForUrl,
  userId,
}: {
  organizationNameForUrl: string;
  tournamentNameForUrl: string;
  userId?: string;
}) {
  const tournaments = await Tournament.findByNameForUrlWithInviteCodes(
    tournamentNameForUrl
  );

  const tournament = tournaments.find(
    (tournament) =>
      tournament.organizer.nameForUrl === organizationNameForUrl.toLowerCase()
  );

  if (!tournament) throw new Response("No tournament found", { status: 404 });

  const ownTeam = tournament.teams.find((team) =>
    team.members.some(({ captain, member }) => captain && member.id === userId)
  );

  if (!ownTeam) throw new Response("No own team found", { status: 404 });

  return ownTeam;
}

export async function findTournamentWithInviteCodes({
  organizationNameForUrl,
  tournamentNameForUrl,
}: {
  organizationNameForUrl: string;
  tournamentNameForUrl: string;
}) {
  const tournaments = await Tournament.findByNameForUrlWithInviteCodes(
    tournamentNameForUrl
  );

  const result = tournaments.find(
    (tournament) =>
      tournament.organizer.nameForUrl === organizationNameForUrl.toLowerCase()
  );

  if (!result) throw new Response("No tournament found", { status: 404 });

  return result;
}

export const createTournamentTeam = TournamentTeam.create;

export async function createTournamentRounds({
  organizationNameForUrl,
  tournamentNameForUrl,
  mapList,
  userId,
  bracketId,
}: {
  organizationNameForUrl: string;
  tournamentNameForUrl: string;
  mapList: MapListIds;
  userId: string;
  bracketId: string;
}) {
  const tournament = await Tournament.findByNameForUrl({
    organizationNameForUrl,
    tournamentNameForUrl,
  });

  if (!tournament) throw new Response("No tournament found", { status: 404 });
  if (!isTournamentAdmin({ organization: tournament.organizer, userId })) {
    throw new Response("Not tournament admin", { status: 401 });
  }

  const bracket = tournament.brackets.find(
    (bracket) => bracket.id === bracketId
  );
  // TODO: OR rounds i.e. bracket was already started
  if (!bracket) {
    throw new Response("Invalid bracket id provided", { status: 400 });
  }

  const participantsSeeded = tournament.teams
    .filter((team) => team.checkedInTime)
    .sort(sortTeamsBySeed(tournament.seeds));

  const rounds = tournamentRoundsForDB({
    mapList,
    bracketType: bracket.type,
    participantsSeeded,
  });

  // TODO: use models
  return db.$transaction([
    db.tournamentRound.createMany({
      data: rounds.map((round) => ({
        bracketId: bracket.id,
        id: round.id,
        position: round.position,
      })),
    }),
    db.tournamentRoundStage.createMany({
      data: rounds.flatMap((round) => {
        return round.stages.map(({ position, stageId }) => ({
          position,
          stageId,
          roundId: round.id,
        }));
      }),
    }),
    db.tournamentMatch.createMany({
      data: rounds.flatMap((round) => {
        return round.matches.map((match) => ({
          id: match.id,
          position: match.number,
          roundId: round.id,
          winnerDestinationMatchId: match.winnerDestinationMatchId,
          loserDestinationMatchId: match.loserDestinationMatchId,
        }));
      }),
    }),
    db.tournamentMatchParticipant.createMany({
      data: rounds.flatMap((round) => {
        return round.matches.flatMap((match) => {
          return match.participants.flatMap((participant) => {
            if (participant.team === "BYE") return [];
            return {
              teamId: participant.team.id,
              matchId: match.id,
              order: participant.order,
            };
          });
        });
      }),
    }),
  ]);
}

export async function joinTeamViaInviteCode({
  tournamentId,
  inviteCode,
  userId,
}: {
  tournamentId: string;
  inviteCode: string;
  userId: string;
}) {
  const tournament = await Tournament.findById(tournamentId);

  if (!tournament) throw new Response("Invalid tournament id", { status: 400 });

  // TODO: 400 if tournament already started / concluded (depending on if tournament allows mid-event roster additions)

  const tournamentTeamToJoin = tournament.teams.find(
    (team) => team.inviteCode === inviteCode
  );
  if (!tournamentTeamToJoin)
    throw new Response("Invalid invite code", { status: 400 });
  if (tournamentTeamToJoin.members.length >= TOURNAMENT_TEAM_ROSTER_MAX_SIZE) {
    throw new Response("Team is already full", { status: 400 });
  }

  const trustReceiverId = captainOfTeam(tournamentTeamToJoin).memberId;

  return Promise.all([
    TournamentTeamMember.joinTeam({
      teamId: tournamentTeamToJoin.id,
      memberId: userId,
      tournamentId,
    }),
    // TODO: this could also be put to queue and scheduled for later
    TrustRelationship.upsert({ trustReceiverId, trustGiverId: userId }),
  ]);
}

export async function editTeam({
  teamId,
  userId,
  friendCode,
  roomPass,
  canHost,
}: {
  teamId: string;
  userId: string;
  friendCode: string;
  roomPass: string | null;
  canHost: boolean;
}) {
  const tournamentTeam = await TournamentTeam.findById(teamId);
  if (!tournamentTeam) throw new Response("Invalid team id", { status: 400 });

  if (
    !tournamentTeam.members.some(
      ({ memberId, captain }) => captain && memberId === userId
    )
  ) {
    throw new Response("Not captain of the team", { status: 401 });
  }

  return TournamentTeam.editTeam({
    id: teamId,
    canHost,
    friendCode,
    roomPass,
  });
}

export async function removePlayerFromTeam({
  teamId,
  userId,
  playerId,
}: {
  teamId: string;
  userId: string;
  playerId: string;
}) {
  if (userId === playerId) {
    throw new Response("Can't remove self", { status: 400 });
  }

  const tournamentTeam = await TournamentTeam.findById(teamId);

  if (!tournamentTeam) throw new Response("Invalid team id", { status: 400 });
  if (tournamentTeam.checkedInTime) {
    throw new Response("Can't remove players after checking in", {
      status: 400,
    });
  }
  if (
    !tournamentTeam.members.some(
      ({ memberId, captain }) => captain && memberId === userId
    )
  ) {
    throw new Response("Not captain of the team", { status: 401 });
  }

  return TournamentTeamMember.del({
    memberId: playerId,
    tournamentId: tournamentTeam.tournament.id,
  });
}

export async function checkIn({
  teamId,
  userId,
}: {
  teamId: string;
  userId: string;
}) {
  const tournamentTeam = await TournamentTeam.findById(teamId);

  if (!tournamentTeam) throw new Response("Invalid team id", { status: 400 });

  if (
    !isTournamentAdmin({
      userId,
      organization: tournamentTeam.tournament.organizer,
    }) &&
    !tournamentTeam.members.some(
      ({ memberId, captain }) => captain && memberId === userId
    )
  ) {
    throw new Response("Not captain of the team", { status: 401 });
  }
  // cut them some slack so UI never shows you can check in when you can't
  const checkInCutOff = TOURNAMENT_CHECK_IN_CLOSING_MINUTES_FROM_START - 2;
  if (
    !isTournamentAdmin({
      userId,
      organization: tournamentTeam.tournament.organizer,
    }) &&
    tournamentTeam.tournament.startTime.getTime() - checkInCutOff * 60000 <
      new Date().getTime()
  ) {
    throw new Response("Check in time has passed", { status: 400 });
  }

  // TODO: fail if tournament has started

  return TournamentTeam.checkIn(teamId);
}

export async function checkOut({
  teamId,
  userId,
}: {
  teamId: string;
  userId: string;
}) {
  const tournamentTeam = await TournamentTeam.findById(teamId);
  if (!tournamentTeam) throw new Response("Invalid team id", { status: 400 });
  if (
    !isTournamentAdmin({
      organization: tournamentTeam.tournament.organizer,
      userId,
    })
  ) {
    throw new Response("Not tournament admin", { status: 401 });
  }

  // TODO: fail if tournament has started

  return TournamentTeam.checkOut(teamId);
}
