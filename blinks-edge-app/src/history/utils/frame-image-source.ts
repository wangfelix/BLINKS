import { ImageSource } from "expo-image";

import { appConfig } from "@/application/config/app-config";
import { sessionHolder } from "@/authentication/storage/session-holder";
import { SessionFrame } from "@/sessions/types/session-types";

export const getFrameImageSource = (frame: SessionFrame): ImageSource => {
  const token = sessionHolder.getToken();
  const source = { uri: `${appConfig.serverUrl}${frame.imageUrl}` };

  return token
    ? {
        ...source,
        headers: { Authorization: `Bearer ${token}` },
      }
    : source;
};
