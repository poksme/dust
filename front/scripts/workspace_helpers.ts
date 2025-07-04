import { WorkspaceModel } from "@app/lib/resources/storage/models/workspace";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import { renderLightWorkspaceType } from "@app/lib/workspace";
import type { LightWorkspaceType } from "@app/types";

export async function runOnAllWorkspaces(
  worker: (workspace: LightWorkspaceType) => Promise<void>,
  { concurrency }: { concurrency: number } = { concurrency: 1 }
) {
  const workspaces = await WorkspaceModel.findAll({});

  await concurrentExecutor(
    workspaces,
    (workspace) => worker(renderLightWorkspaceType({ workspace })),
    { concurrency }
  );
}
