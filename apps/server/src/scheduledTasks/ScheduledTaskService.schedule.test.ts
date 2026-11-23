import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:edit-after-delete",
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stale-schedule",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const created = yield* service.upsert(input);
      const edit = yield* decodeUpsertInput({ ...input, requireExisting: true, title: "Edited" });
      expect((yield* service.upsert(edit)).task.title).toBe("Edited");
      yield* service.delete({ id: created.task.id });

      const failure = yield* service.upsert(edit).pipe(Effect.flip);
      expect(failure.message).toBe("Schedule task not found.");
      expect((yield* service.list()).tasks).toEqual([]);

      expect((yield* service.upsert(input)).task.id).toBe(created.task.id);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("preserves a due run when a save only pads the scheduled hour", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        commandId: "schedule-time-format",
        title: "Morning review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "9:00" },
        projectId: "project-schedule-time-format",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mcp",
      });
      const created = yield* service.upsert(input);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 1_000);
      const update = yield* decodeUpsertInput({
        ...input,
        id: created.task.id,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const updated = yield* service.upsert(update);
      expect(updated.task.nextRunAt).toBe(expectedDueAt);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expectedDueAt);

      const rescheduled = yield* service.upsert({
        ...update,
        schedule: { type: "fixed_time", timeOfDay: "09:30" },
      });
      expect(rescheduled.task.nextRunAt).toBe(
        DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { minutes: 30 }))),
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps the task list order when a toggle or edit rewrites updated_at", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = (id: string) => ({
        id,
        title: id,
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stable-order",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const listedIds = service
        .list()
        .pipe(Effect.map(({ tasks }) => tasks.map((task) => String(task.id))));

      const older = yield* service.upsert(yield* decodeUpsertInput(input("scheduled-task:older")));
      yield* TestClock.adjust("1 second");
      yield* service.upsert(yield* decodeUpsertInput(input("scheduled-task:newer")));
      const order = ["scheduled-task:newer", "scheduled-task:older"];
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const toggled = yield* service.setEnabled({ id: older.task.id, enabled: false });
      expect(toggled.task.updatedAt > older.task.updatedAt).toBe(true);
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const edit = { ...input(older.task.id), requireExisting: true, title: "Edited" };
      yield* service.upsert(yield* decodeUpsertInput({ ...edit, enabled: false }));
      expect(yield* listedIds).toEqual(order);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "idle polls still wake for tasks saved later, recorded due times, and beside far-future tasks",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
      const launched = yield* Deferred.make<string>();
      const layerDependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Deferred.succeed(launched, input.title).pipe(
              Effect.as({ threadId: "thread-idle-poll", resumed: false } as never),
            ),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        // The first poll finds no tasks and remembers that nothing is due.
        yield* TestClock.adjust("6 seconds");
        // Its year-10000+ next run sorts first as text; it must not hide the task below.
        yield* service.upsert(
          yield* decodeUpsertInput({
            title: "Far future",
            prompt: "Review the open pull requests.",
            enabled: true,
            schedule: { type: "interval", everyMs: 3e14 },
            projectId: "project-idle-poll",
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        );
        const created = yield* service.upsert(
          yield* decodeUpsertInput({
            title: "Idle poll",
            prompt: "Review the open pull requests.",
            enabled: true,
            schedule: { type: "interval", everyMs: 60_000 },
            projectId: "project-idle-poll",
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        );
        // This poll records the new task's due time; the later ones must still fire it.
        yield* TestClock.adjust("6 seconds");
        yield* TestClock.adjust("60 seconds");
        expect(yield* Deferred.await(launched)).toBe(created.task.title);
      }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "issues a missed fixed-time run for tasks classified important or time-sensitive, not for routine ones",
  () =>
    Effect.gen(function* () {
      const dueAt = DateTime.makeZonedUnsafe(
        { year: 2026, month: 11, day: 10, hour: 9, minute: 0, second: 0, millisecond: 0 },
        { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
      );
      // One minute before the slot, as if the environment was about to sleep through it.
      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 60_000);
      const sql = yield* SqlClient.SqlClient;
      const launched = yield* Ref.make<string[]>([]);
      // The scheduler is held: its ticks are captured and run by hand after the clock
      // jumps, so no intermediate poll can see the slot while the "machine" sleeps.
      const ticks = yield* Ref.make<ReadonlyArray<Effect.Effect<void>>>([]);
      const layerDependencies = Layer.mergeAll(
        NodeCrypto.layer,
        ManagedPolicy.layerTest(),
        Layer.mock(Scheduler.Scheduler)({
          register: ((_name: string, runDueWork: Effect.Effect<void>) =>
            Ref.update(ticks, (all) => [...all, runDueWork])) as never,
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Ref.update(launched, (titles) => [...titles, input.title]).pipe(
              Effect.as({ threadId: "thread:missed-run-classification", resumed: false } as never),
            ),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const input = (title: string, importance?: "important" | "time_sensitive") => ({
          id: `scheduled-task:missed-${title.toLowerCase()}`,
          title,
          prompt: `${title} prompt`,
          enabled: true,
          schedule: { type: "fixed_time", timeOfDay: "09:00" },
          ...(importance === undefined ? {} : { importance }),
          projectId: "project-missed-run-classification",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        const routine = yield* service.upsert(yield* decodeUpsertInput(input("Routine")));
        const important = yield* service.upsert(
          yield* decodeUpsertInput(input("Important", "important")),
        );
        const sensitive = yield* service.upsert(
          yield* decodeUpsertInput(input("Sensitive", "time_sensitive")),
        );
        const slot = DateTime.formatIso(DateTime.toUtc(dueAt));
        expect(routine.task.nextRunAt).toBe(slot);
        expect(important.task.nextRunAt).toBe(slot);
        expect(sensitive.task.nextRunAt).toBe(slot);
        expect(important.task.importance).toBe("important");
        expect(sensitive.task.importance).toBe("time_sensitive");
        expect(routine.task.importance).toBeUndefined();

        // Sleep two hours past the slot: past the 10-minute missed-run grace.
        yield* TestClock.adjust(
          DateTime.toEpochMillis(DateTime.add(dueAt, { hours: 2 })) -
            (DateTime.toEpochMillis(dueAt) - 60_000),
        );
        for (const tick of yield* Ref.get(ticks)) yield* tick;

        expect(yield* Ref.get(launched)).toEqual(["Important", "Sensitive"]);
        const rows = yield* sql<{
          task_id: string;
          last_run_status: string;
          run_count: number;
          next_run_at: string | null;
        }>`SELECT task_id, last_run_status, run_count, next_run_at FROM scheduled_tasks ORDER BY task_id`;
        const byId = new Map(rows.map((row) => [row.task_id, row]));
        expect(byId.get("scheduled-task:missed-routine")).toMatchObject({
          last_run_status: "never",
          run_count: 0,
        });
        expect(byId.get("scheduled-task:missed-important")).toMatchObject({
          last_run_status: "succeeded",
          run_count: 1,
        });
        expect(byId.get("scheduled-task:missed-sensitive")).toMatchObject({
          last_run_status: "succeeded",
          run_count: 1,
        });
        // All three point at the next slot: the skipped one was rescheduled, not left due.
        const nextRuns = new Set(rows.map((row) => row.next_run_at));
        expect(nextRuns.size).toBe(1);
        expect([...nextRuns][0]).toBe(
          DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { days: 1 }))),
        );
      }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
