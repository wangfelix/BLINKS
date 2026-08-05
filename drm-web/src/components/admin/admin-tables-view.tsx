"use client";

import { type FormEvent, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DatabaseIcon,
  DownloadIcon,
  ListFilterIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";

import {
  ADMIN_TABLES,
  downloadAdminTable,
  getAdminOverview,
  getAdminTable,
  type AdminCellValue,
  type AdminTableName,
} from "@/lib/admin-api";
import { mergeClassNames } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PAGE_SIZE = 50;

const tableCopy: Record<
  AdminTableName,
  { label: string; description: string }
> = {
  frames: {
    label: "Frames",
    description: "Capture, file, anonymization, and deletion metadata",
  },
  chunks: {
    label: "5-minute chunks",
    description: "VLM processing state, labels, and confidence distributions",
  },
  activity_lists: {
    label: "Activity lists",
    description: "Self, immutable proposal, and assisted list workflow",
  },
  activities: {
    label: "Activities",
    description: "Episode spans, labels, provenance, and ratings",
  },
};

const countFormat = new Intl.NumberFormat("en");

const CellValue = ({ value }: { value: AdminCellValue }) => {
  if (value === null) {
    return <span className="text-xs text-muted-foreground italic">NULL</span>;
  }
  const text = String(value);
  return (
    <span
      className={mergeClassNames(
        "block max-w-[30rem] truncate font-mono text-xs",
        typeof value === "number" && "text-right tabular-nums",
      )}
      title={text}
    >
      {text}
    </span>
  );
};

export const AdminTablesView = () => {
  const [table, setTable] = useState<AdminTableName>("frames");
  const [page, setPage] = useState(1);
  const [filterColumn, setFilterColumn] = useState("all");
  const [filterInput, setFilterInput] = useState("");
  const [search, setSearch] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const overviewQuery = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: getAdminOverview,
  });
  const tableQuery = useQuery({
    queryKey: [
      "admin",
      "table",
      table,
      page,
      PAGE_SIZE,
      search,
      search === "" || filterColumn === "all" ? null : filterColumn,
    ],
    queryFn: () =>
      getAdminTable(
        table,
        page,
        PAGE_SIZE,
        search,
        search === "" || filterColumn === "all" ? null : filterColumn,
      ),
    placeholderData: keepPreviousData,
  });

  const totalPages = Math.max(
    1,
    Math.ceil((tableQuery.data?.total ?? 0) / PAGE_SIZE),
  );

  const selectTable = (nextTable: AdminTableName) => {
    setTable(nextTable);
    setPage(1);
    setFilterColumn("all");
    setFilterInput("");
    setSearch("");
    setDownloadError(null);
  };

  const applyFilter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearch(filterInput.trim());
    setPage(1);
  };

  const clearFilter = () => {
    setFilterColumn("all");
    setFilterInput("");
    setSearch("");
    setPage(1);
  };

  const tableColumns =
    tableQuery.data?.table === table ? tableQuery.data.columns : [];
  const columnItems = [
    { value: "all", label: "All columns" },
    ...tableColumns.map((column) => ({ value: column, label: column })),
  ];
  const hasActiveFilter = search !== "";
  const hasFilterControls =
    filterColumn !== "all" || filterInput !== "" || hasActiveFilter;

  const handleDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadAdminTable(table);
    } catch (error) {
      setDownloadError(
        error instanceof Error
          ? error.message
          : "The CSV could not be downloaded.",
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="database-heading">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
            Research database
          </p>
          <h2 id="database-heading" className="mt-1 text-2xl font-semibold">
            Data tables
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Filter and browse 50 rows at a time or export a complete table as
            CSV.
          </p>
        </div>
        <Button
          variant="outline"
          className="bg-background/80"
          disabled={downloading}
          onClick={() => void handleDownload()}
        >
          {downloading ? (
            <LoaderCircleIcon className="animate-spin" aria-hidden />
          ) : (
            <DownloadIcon aria-hidden />
          )}
          Download {tableCopy[table].label} CSV
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {ADMIN_TABLES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => selectTable(candidate)}
            className={mergeClassNames(
              "rounded-2xl border p-4 text-left shadow-sm transition-[border-color,background-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring",
              table === candidate
                ? "border-foreground/20 bg-foreground text-background shadow-md"
                : "border-white/50 bg-background/75 hover:border-border hover:bg-background dark:border-white/10",
            )}
            aria-pressed={table === candidate}
          >
            <div className="flex items-start justify-between gap-3">
              <span
                className={mergeClassNames(
                  "grid size-9 place-items-center rounded-xl",
                  table === candidate
                    ? "bg-background/12"
                    : "bg-primary/8 text-primary",
                )}
              >
                <DatabaseIcon className="size-4" aria-hidden />
              </span>
              <span className="font-mono text-sm tabular-nums">
                {overviewQuery.data === undefined
                  ? "—"
                  : countFormat.format(
                      overviewQuery.data.tableCounts[candidate],
                    )}
              </span>
            </div>
            <p className="mt-3 font-semibold">{tableCopy[candidate].label}</p>
            <p
              className={mergeClassNames(
                "mt-1 text-xs leading-relaxed",
                table === candidate
                  ? "text-background/70"
                  : "text-muted-foreground",
              )}
            >
              {tableCopy[candidate].description}
            </p>
          </button>
        ))}
      </div>

      {downloadError !== null && (
        <Alert variant="destructive">
          <AlertTitle>Download failed</AlertTitle>
          <AlertDescription>{downloadError}</AlertDescription>
        </Alert>
      )}

      <Card className="gap-0 rounded-2xl bg-background/82 py-0 shadow-lg backdrop-blur-xl">
        <CardHeader className="border-b border-border/70 py-5">
          <CardTitle>{tableCopy[table].label}</CardTitle>
          <CardDescription>{tableCopy[table].description}</CardDescription>
          <CardAction>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh table"
              onClick={() => void tableQuery.refetch()}
            >
              <RefreshCwIcon
                className={tableQuery.isFetching ? "animate-spin" : undefined}
              />
            </Button>
          </CardAction>
        </CardHeader>

        <form
          onSubmit={applyFilter}
          className="grid gap-3 border-b border-border/70 bg-muted/20 px-4 py-4 sm:px-5 md:grid-cols-[minmax(180px,0.55fr)_minmax(260px,1fr)_auto] md:items-end"
        >
          <div className="space-y-2">
            <Label htmlFor="admin-table-filter-column">Search column</Label>
            <Select
              items={columnItems}
              value={filterColumn}
              onValueChange={(value) => {
                if (value === null) return;
                setFilterColumn(value);
                if (search !== "") setPage(1);
              }}
              disabled={tableColumns.length === 0}
            >
              <SelectTrigger
                id="admin-table-filter-column"
                className="w-full bg-background"
              >
                <SelectValue placeholder="All columns" />
              </SelectTrigger>
              <SelectContent align="start" alignItemWithTrigger={false}>
                <SelectItem value="all">All columns</SelectItem>
                {tableColumns.map((column) => (
                  <SelectItem key={column} value={column}>
                    <span className="font-mono text-xs">{column}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="admin-table-filter-value">Contains</Label>
            <div className="relative">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                id="admin-table-filter-value"
                value={filterInput}
                onChange={(event) => setFilterInput(event.target.value)}
                placeholder={
                  filterColumn === "all"
                    ? "Search every column…"
                    : `Search ${filterColumn}…`
                }
                maxLength={200}
                className="bg-background pl-9"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <Button type="submit" className="flex-1 md:flex-none">
              <ListFilterIcon aria-hidden />
              Apply filter
            </Button>
            {hasFilterControls && (
              <Button
                type="button"
                variant="outline"
                className="bg-background"
                onClick={clearFilter}
              >
                <XIcon aria-hidden />
                Clear
              </Button>
            )}
          </div>
        </form>

        {tableQuery.isError ? (
          <CardContent className="py-10">
            <Alert variant="destructive">
              <AlertTitle>Table unavailable</AlertTitle>
              <AlertDescription>
                {tableQuery.error instanceof Error
                  ? tableQuery.error.message
                  : "The table could not be loaded."}
              </AlertDescription>
            </Alert>
          </CardContent>
        ) : tableQuery.data === undefined ? (
          <CardContent className="flex min-h-72 items-center justify-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="animate-spin" aria-hidden />
            Loading rows…
          </CardContent>
        ) : tableQuery.data.rows.length === 0 ? (
          <CardContent className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
            {hasActiveFilter
              ? "No rows match this filter."
              : "This table is empty."}
          </CardContent>
        ) : (
          <div className="overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/55">
                <TableRow>
                  {tableQuery.data.columns.map((column) => (
                    <TableHead key={column} className="px-3 font-mono text-xs">
                      {column}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {tableQuery.data.rows.map((row, rowIndex) => (
                  <TableRow key={`${table}-${page}-${rowIndex}`}>
                    {tableQuery.data.columns.map((column) => (
                      <TableCell
                        key={column}
                        className="max-w-[30rem] px-3 py-2.5"
                      >
                        <CellValue value={row[column]} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 bg-muted/25 px-4 py-3 sm:px-5">
          <p className="text-xs text-muted-foreground tabular-nums">
            {tableQuery.data === undefined
              ? "Loading row count…"
              : `${countFormat.format(tableQuery.data.total)}${hasActiveFilter ? " matching" : ""} rows · Page ${page} of ${totalPages}`}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="bg-background"
              disabled={page <= 1 || tableQuery.data === undefined}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeftIcon aria-hidden />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="bg-background"
              disabled={page >= totalPages || tableQuery.data === undefined}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
              <ChevronRightIcon aria-hidden />
            </Button>
          </div>
        </div>
      </Card>
    </section>
  );
};
