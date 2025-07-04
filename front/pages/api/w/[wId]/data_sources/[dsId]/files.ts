import type { NextApiRequest, NextApiResponse } from "next";

import { withSessionAuthenticationForWorkspace } from "@app/lib/api/auth_wrappers";
import type {
  UpsertDocumentArgs,
  UpsertTableArgs,
} from "@app/lib/api/data_sources";
import { processAndUpsertToDataSource } from "@app/lib/api/files/upsert";
import type { Authenticator } from "@app/lib/auth";
import { DataSourceResource } from "@app/lib/resources/data_source_resource";
import { FileResource } from "@app/lib/resources/file_resource";
import { apiError } from "@app/logger/withlogging";
import type { APIErrorType, FileType, WithAPIErrorResponse } from "@app/types";

export interface UpsertFileToDataSourceRequestBody {
  fileId: string;
  upsertArgs?:
    | Pick<UpsertDocumentArgs, "document_id" | "title" | "tags">
    | Pick<
        UpsertTableArgs,
        "name" | "title" | "description" | "tags" | "tableId"
      >;
}

export interface UpsertFileToDataSourceResponseBody {
  file: FileType;
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<WithAPIErrorResponse<{ file: FileType }>>,
  auth: Authenticator
): Promise<void> {
  const { dsId } = req.query;
  if (typeof dsId !== "string") {
    return apiError(req, res, {
      status_code: 400,
      api_error: {
        type: "invalid_request_error",
        message: "Invalid path parameters.",
      },
    });
  }

  const { fileId, upsertArgs } = req.body;

  // Get file and make sure that it is within the same workspace.
  const file = await FileResource.fetchById(auth, fileId);
  if (!file) {
    return apiError(req, res, {
      status_code: 404,
      api_error: {
        type: "file_not_found",
        message: "File not found.",
      },
    });
  }

  // Only folder document and table upserts are supported on this endpoint.
  if (
    !["upsert_document", "upsert_table", "folders_document"].includes(
      file.useCase
    )
  ) {
    return apiError(req, res, {
      status_code: 400,
      api_error: {
        type: "invalid_request_error",
        message:
          "Only folder document and table upserts are supported on this endpoint.",
      },
    });
  }

  switch (req.method) {
    case "POST": {
      let dataSourceToUse: DataSourceResource | null = null;

      const dataSource = await DataSourceResource.fetchById(auth, dsId);
      if (!dataSource) {
        return apiError(req, res, {
          status_code: 404,
          api_error: {
            type: "data_source_not_found",
            message: `Could not find data source with id ${dsId}`,
          },
        });
      }
      dataSourceToUse = dataSource;

      if (!dataSourceToUse.canWrite(auth)) {
        return apiError(req, res, {
          status_code: 403,
          api_error: {
            type: "data_source_auth_error",
            message: "You are not authorized to upsert to this data source.",
          },
        });
      }

      const rUpsert = await processAndUpsertToDataSource(
        auth,
        dataSourceToUse,
        { file, upsertArgs: upsertArgs }
      );
      if (rUpsert.isErr()) {
        let status_code: number;
        let type: APIErrorType;

        switch (rUpsert.error.code) {
          case "file_not_ready":
          case "invalid_file":
          case "title_too_long":
          case "invalid_url":
          case "missing_csv":
          case "invalid_csv_content":
          case "invalid_csv_and_file":
          case "invalid_content_error":
          case "connection_not_found":
          case "table_not_found":
          case "file_not_found":
            status_code = 400;
            type = "invalid_request_error";
            break;

          case "data_source_quota_error":
            status_code = 413;
            type = "data_source_quota_error";
            break;

          default:
            status_code = 500;
            type = "internal_server_error";
            break;
        }

        return apiError(req, res, {
          status_code,
          api_error: {
            type: type,
            message: rUpsert.error.message,
          },
        });
      }

      return res.status(200).json({ file: file.toPublicJSON(auth) });
    }
    default:
      return apiError(req, res, {
        status_code: 405,
        api_error: {
          type: "method_not_supported_error",
          message: "The method passed is not supported, POST is expected.",
        },
      });
  }
}

export default withSessionAuthenticationForWorkspace(handler);
