import type { Metadata } from "next";

import { AdminPageClient } from "@/components/admin/admin-page-client";

export const metadata: Metadata = {
  title: "BLINKS — Research Admin",
  description: "Administrative data and participant operations for BLINKS.",
};

const AdminPage = () => <AdminPageClient />;

export default AdminPage;
