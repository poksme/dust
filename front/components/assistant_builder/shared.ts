import type {
  DataSourceType,
  LightContentNode,
  TimeframeUnit,
} from "@app/types";
import { assertNever } from "@app/types";

export const TIME_FRAME_UNIT_TO_LABEL: Record<TimeframeUnit, string> = {
  hour: "hour(s)",
  day: "day(s)",
  week: "week(s)",
  month: "month(s)",
  year: "year(s)",
};

export const DROID_AVATARS_BASE_PATH = "/static/droidavatar/";

export const DROID_AVATAR_FILES = [
  "Droid_Yellow_8.jpg",
  "Droid_Yellow_7.jpg",
  "Droid_Yellow_6.jpg",
  "Droid_Yellow_5.jpg",
  "Droid_Yellow_4.jpg",
  "Droid_Yellow_3.jpg",
  "Droid_Yellow_2.jpg",
  "Droid_Yellow_1.jpg",
  "Droid_Teal_8.jpg",
  "Droid_Teal_7.jpg",
  "Droid_Teal_6.jpg",
  "Droid_Teal_5.jpg",
  "Droid_Teal_4.jpg",
  "Droid_Teal_3.jpg",
  "Droid_Teal_2.jpg",
  "Droid_Teal_1.jpg",
  "Droid_Sky_8.jpg",
  "Droid_Sky_7.jpg",
  "Droid_Sky_6.jpg",
  "Droid_Sky_5.jpg",
  "Droid_Sky_4.jpg",
  "Droid_Sky_3.jpg",
  "Droid_Sky_2.jpg",
  "Droid_Sky_1.jpg",
  "Droid_Red_8.jpg",
  "Droid_Red_7.jpg",
  "Droid_Red_6.jpg",
  "Droid_Red_5.jpg",
  "Droid_Red_4.jpg",
  "Droid_Red_3.jpg",
  "Droid_Red_2.jpg",
  "Droid_Red_1.jpg",
  "Droid_Purple_8.jpg",
  "Droid_Purple_7.jpg",
  "Droid_Purple_6.jpg",
  "Droid_Purple_5.jpg",
  "Droid_Purple_4.jpg",
  "Droid_Purple_3.jpg",
  "Droid_Purple_2.jpg",
  "Droid_Purple_1.jpg",
  "Droid_Pink_8.jpg",
  "Droid_Pink_7.jpg",
  "Droid_Pink_6.jpg",
  "Droid_Pink_5.jpg",
  "Droid_Pink_4.jpg",
  "Droid_Pink_3.jpg",
  "Droid_Pink_2.jpg",
  "Droid_Pink_1.jpg",
  "Droid_Orange_8.jpg",
  "Droid_Orange_7.jpg",
  "Droid_Orange_6.jpg",
  "Droid_Orange_5.jpg",
  "Droid_Orange_4.jpg",
  "Droid_Orange_3.jpg",
  "Droid_Orange_2.jpg",
  "Droid_Orange_1.jpg",
  "Droid_Lime_8.jpg",
  "Droid_Lime_7.jpg",
  "Droid_Lime_6.jpg",
  "Droid_Lime_5.jpg",
  "Droid_Lime_4.jpg",
  "Droid_Lime_3.jpg",
  "Droid_Lime_2.jpg",
  "Droid_Lime_1.jpg",
  "Droid_Indigo_8.jpg",
  "Droid_Indigo_7.jpg",
  "Droid_Indigo_6.jpg",
  "Droid_Indigo_5.jpg",
  "Droid_Indigo_4.jpg",
  "Droid_Indigo_3.jpg",
  "Droid_Indigo_2.jpg",
  "Droid_Indigo_1.jpg",
  "Droid_Green_8.jpg",
  "Droid_Green_7.jpg",
  "Droid_Green_6.jpg",
  "Droid_Green_5.jpg",
  "Droid_Green_4.jpg",
  "Droid_Green_3.jpg",
  "Droid_Green_2.jpg",
  "Droid_Green_1.jpg",
  "Droid_Cream_8.jpg",
  "Droid_Cream_7.jpg",
  "Droid_Cream_6.jpg",
  "Droid_Cream_5.jpg",
  "Droid_Cream_4.jpg",
  "Droid_Cream_3.jpg",
  "Droid_Cream_2.jpg",
  "Droid_Cream_1.jpg",
  "Droid_Black_8.jpg",
  "Droid_Black_7.jpg",
  "Droid_Black_6.jpg",
  "Droid_Black_5.jpg",
  "Droid_Black_4.jpg",
  "Droid_Black_3.jpg",
  "Droid_Black_2.jpg",
  "Droid_Black_1.jpg",
];

export const SPIRIT_AVATARS_BASE_PATH = "/static/spiritavatar/";

export const SPIRIT_AVATAR_FILES = [
  "Spirit_Black_1.jpg",
  "Spirit_Black_2.jpg",
  "Spirit_Black_3.jpg",
  "Spirit_Black_4.jpg",
  "Spirit_Black_5.jpg",
  "Spirit_Black_6.jpg",
  "Spirit_Black_7.jpg",
  "Spirit_Black_8.jpg",
  "Spirit_Cream_1.jpg",
  "Spirit_Cream_2.jpg",
  "Spirit_Cream_3.jpg",
  "Spirit_Cream_4.jpg",
  "Spirit_Cream_5.jpg",
  "Spirit_Cream_6.jpg",
  "Spirit_Cream_7.jpg",
  "Spirit_Cream_8.jpg",
  "Spirit_Green_1.jpg",
  "Spirit_Green_2.jpg",
  "Spirit_Green_3.jpg",
  "Spirit_Green_4.jpg",
  "Spirit_Green_5.jpg",
  "Spirit_Green_6.jpg",
  "Spirit_Green_7.jpg",
  "Spirit_Green_8.jpg",
  "Spirit_Indigo_1.jpg",
  "Spirit_Indigo_2.jpg",
  "Spirit_Indigo_3.jpg",
  "Spirit_Indigo_4.jpg",
  "Spirit_Indigo_5.jpg",
  "Spirit_Indigo_6.jpg",
  "Spirit_Indigo_7.jpg",
  "Spirit_Indigo_8.jpg",
  "Spirit_Lime_1.jpg",
  "Spirit_Lime_2.jpg",
  "Spirit_Lime_3.jpg",
  "Spirit_Lime_4.jpg",
  "Spirit_Lime_5.jpg",
  "Spirit_Lime_6.jpg",
  "Spirit_Lime_7.jpg",
  "Spirit_Lime_8.jpg",
  "Spirit_Orange_1.jpg",
  "Spirit_Orange_2.jpg",
  "Spirit_Orange_3.jpg",
  "Spirit_Orange_4.jpg",
  "Spirit_Orange_5.jpg",
  "Spirit_Orange_6.jpg",
  "Spirit_Orange_7.jpg",
  "Spirit_Orange_8.jpg",
  "Spirit_Pink_1.jpg",
  "Spirit_Pink_2.jpg",
  "Spirit_Pink_3.jpg",
  "Spirit_Pink_4.jpg",
  "Spirit_Pink_5.jpg",
  "Spirit_Pink_6.jpg",
  "Spirit_Pink_7.jpg",
  "Spirit_Pink_8.jpg",
  "Spirit_Purple_1.jpg",
  "Spirit_Purple_2.jpg",
  "Spirit_Purple_3.jpg",
  "Spirit_Purple_4.jpg",
  "Spirit_Purple_5.jpg",
  "Spirit_Purple_6.jpg",
  "Spirit_Purple_7.jpg",
  "Spirit_Purple_8.jpg",
  "Spirit_Red_1.jpg",
  "Spirit_Red_2.jpg",
  "Spirit_Red_3.jpg",
  "Spirit_Red_4.jpg",
  "Spirit_Red_5.jpg",
  "Spirit_Red_6.jpg",
  "Spirit_Red_7.jpg",
  "Spirit_Red_8.jpg",
  "Spirit_Sky_1.jpg",
  "Spirit_Sky_2.jpg",
  "Spirit_Sky_3.jpg",
  "Spirit_Sky_4.jpg",
  "Spirit_Sky_5.jpg",
  "Spirit_Sky_6.jpg",
  "Spirit_Sky_7.jpg",
  "Spirit_Sky_8.jpg",
  "Spirit_Teal_1.jpg",
  "Spirit_Teal_2.jpg",
  "Spirit_Teal_3.jpg",
  "Spirit_Teal_4.jpg",
  "Spirit_Teal_5.jpg",
  "Spirit_Teal_6.jpg",
  "Spirit_Teal_7.jpg",
  "Spirit_Teal_8.jpg",
  "Spirit_Yellow_1.jpg",
  "Spirit_Yellow_2.jpg",
  "Spirit_Yellow_3.jpg",
  "Spirit_Yellow_4.jpg",
  "Spirit_Yellow_5.jpg",
  "Spirit_Yellow_6.jpg",
  "Spirit_Yellow_7.jpg",
  "Spirit_Yellow_8.jpg",
];

export const EMOJI_AVATARS_BASE_PATH = "/static/";

// Avatar URLs
const BASE_URL = "https://dust.tt/";
const buildAvatarUrl = (basePath: string, fileName: string) => {
  const url = new URL(BASE_URL);
  url.pathname = `${basePath}${fileName}`;
  return url.toString();
};

export const DROID_AVATAR_URLS = DROID_AVATAR_FILES.map((f) =>
  buildAvatarUrl(DROID_AVATARS_BASE_PATH, f)
);
export const SPIRIT_AVATAR_URLS = SPIRIT_AVATAR_FILES.map((f) =>
  buildAvatarUrl(SPIRIT_AVATARS_BASE_PATH, f)
);

export const EMOJI_AVATAR_BASE_URL = buildAvatarUrl(
  EMOJI_AVATARS_BASE_PATH,
  ""
);

export function getTableIdForContentNode(
  dataSource: DataSourceType,
  contentNode: LightContentNode
): string {
  if (contentNode.type !== "table") {
    throw new Error(`ContentNode type ${contentNode.type} is not supported`);
  }

  // We specify whether the connector supports TableQuery as a safeguard in case somehow a non-table node was selected.
  switch (dataSource.connectorProvider) {
    // For static tables, the tableId is the contentNode internalId.
    case null:
    case "bigquery":
    case "microsoft":
    case "notion":
    case "salesforce":
    case "snowflake":
    case "google_drive":
      return contentNode.internalId;

    case "confluence":
    case "github":
    case "gong":
    case "intercom":
    case "slack":
    case "slack_bot":
    case "webcrawler":
    case "zendesk":
      throw new Error(
        `Provider ${dataSource.connectorProvider} is not supported`
      );

    default:
      assertNever(dataSource.connectorProvider);
  }
}
