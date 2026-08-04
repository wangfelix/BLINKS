import { apiClient } from "@/application/api/api-client";
import { StudyStatus } from "@/study/types/study-types";

export const fetchStudyStatus = () =>
  apiClient.get<StudyStatus>("/api/study/status");
