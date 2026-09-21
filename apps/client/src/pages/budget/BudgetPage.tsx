import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CaptureSheet } from "@/components/budget/CaptureSheet";
import { budgetApi, type BudgetReceiptWithItems } from "@/lib/budget-api";
import {
  categoryBreakdownsByCurrency,
  formatMoney,
  receiptMatchesCategoryFilter,
  sumReceiptTotalsByCurrency,
  type CategoryFilter,
} from "@/lib/budget-summary";
import { formatDocumentDate, formatMonthLabel } from "@/lib/format";
import { useIsMobile } from "@/lib/use-media-query";

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function StatusBadges({ receipt }: { receipt: BudgetReceiptWithItems }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {receipt.status === "pending" && (
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading receipt...
        </span>
      )}
      {receipt.status === "needs_review" && <Badge variant="accent2">Needs review</Badge>}
      {receipt.status === "failed" && <Badge variant="destructive">Failed to read</Badge>}
      {receipt.duplicateOfReceiptId && <Badge variant="destructive">Possible duplicate</Badge>}
    </div>
  );
}

function ReceiptCard({ receipt }: { receipt: BudgetReceiptWithItems }) {
  return (
    <Card>
      <CardContent>
        <Link to={`/budget/receipts/${receipt.id}`} className="block space-y-1.5">
          <p className="font-heading text-base">{receipt.merchant ?? "Unknown merchant"}</p>
          <p className="text-sm text-muted-foreground">
            {formatDocumentDate(receipt.purchasedAt)} · {formatMoney(receipt.total, receipt.currency)}
          </p>
          <StatusBadges receipt={receipt} />
        </Link>
      </CardContent>
    </Card>
  );
}

function ReceiptsTable({ receipts }: { receipts: BudgetReceiptWithItems[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Merchant</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Total</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {receipts.map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <Link to={`/budget/receipts/${r.id}`} className="underline-offset-2 hover:underline">
                {r.merchant ?? "Unknown merchant"}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDocumentDate(r.purchasedAt)}</TableCell>
            <TableCell>{formatMoney(r.total, r.currency)}</TableCell>
            <TableCell>
              <StatusBadges receipt={r} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CategoryBreakdownList({
  receipts,
  categories,
  filter,
  onToggleFilter,
}: {
  receipts: BudgetReceiptWithItems[];
  categories: Awaited<ReturnType<typeof budgetApi.listCategories>>;
  filter: CategoryFilter | null;
  onToggleFilter: (next: CategoryFilter) => void;
}) {
  const breakdowns = categoryBreakdownsByCurrency(receipts, categories);
  if (breakdowns.length === 0) return <p className="text-sm text-muted-foreground">No spending recorded yet this month.</p>;

  return (
    <div className="space-y-4">
      {breakdowns.map((group) => (
        <div key={group.currency} className="space-y-2">
          {breakdowns.length > 1 && <p className="text-xs font-medium text-muted-foreground">{group.currency}</p>}
          {group.categories.map((row) => {
            const active = filter?.currency === group.currency && filter.categoryId === row.categoryId;
            return (
              <button
                key={`${group.currency}-${row.categoryId ?? "unmatched"}`}
                type="button"
                onClick={() => onToggleFilter({ currency: group.currency, categoryId: row.categoryId })}
                className={`w-full space-y-1 rounded-2xl border p-2.5 text-left transition-colors ${active ? "border-primary bg-primary/5" : "border-border"}`}
              >
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2">
                    {row.color && <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ backgroundColor: row.color }} />}
                    {row.name}
                  </span>
                  <span className="font-medium">{formatMoney(row.amount, group.currency)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted">
                  <div className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.round(row.share * 100)}%` }} />
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function BudgetPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [month, setMonth] = useState(currentMonth());
  const [filter, setFilter] = useState<CategoryFilter | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["budget", "receipts", month],
    queryFn: () => budgetApi.listMonth(month),
    refetchInterval: (query) => (query.state.data?.receipts.some((r) => r.status === "pending") ? 4000 : false),
  });
  const receipts = data?.receipts ?? [];
  const nearestMonthWithReceipts = data?.nearestMonthWithReceipts ?? null;
  const { data: categories = [] } = useQuery({ queryKey: ["budget", "categories"], queryFn: budgetApi.listCategories });

  const currencyTotals = sumReceiptTotalsByCurrency(receipts);
  const filtered = filter ? receipts.filter((r) => receiptMatchesCategoryFilter(r, filter)) : receipts;

  function toggleFilter(next: CategoryFilter) {
    setFilter((prev) => (prev && prev.currency === next.currency && prev.categoryId === next.categoryId ? null : next));
  }

  // Takes the user straight to the receipt reading itself: the alternative, dropping
  // them back on a month that may not even hold it once the read comes back, is exactly
  // how a correctly saved receipt goes missing from view.
  function handleCreated(receipt: BudgetReceiptWithItems) {
    queryClient.invalidateQueries({ queryKey: ["budget", "receipts"] });
    navigate(`/budget/receipts/${receipt.id}`);
  }

  function goToNearestMonth() {
    if (!nearestMonthWithReceipts) return;
    setMonth(nearestMonthWithReceipts);
    setFilter(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-2xl">Budget</h1>
        <CaptureSheet onCreated={handleCreated} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="month"
          aria-label="Month"
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            setFilter(null);
          }}
          className="h-9 rounded-full border border-input bg-secondary px-4 text-sm"
        />
        <Link to="/budget/categories" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
          Manage categories
        </Link>
      </div>

      <Card>
        <CardContent className="space-y-1">
          <p className="text-xs text-muted-foreground">Total this month</p>
          {currencyTotals.length === 0 ? (
            <p className="font-heading text-2xl">$0.00</p>
          ) : (
            currencyTotals.map((t) => (
              <p key={t.currency} className="font-heading text-2xl">
                {formatMoney(t.total, t.currency)}
              </p>
            ))
          )}
        </CardContent>
      </Card>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-lg">Spend by category</h2>
          {filter && (
            <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setFilter(null)}>
              Clear filter
            </button>
          )}
        </div>
        <CategoryBreakdownList receipts={receipts} categories={categories} filter={filter} onToggleFilter={toggleFilter} />
      </div>

      <div className="space-y-3">
        <h2 className="font-heading text-lg">Receipts</h2>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading</p>
        ) : receipts.length === 0 && nearestMonthWithReceipts ? (
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">No receipts in {formatMonthLabel(month)}.</p>
            <button type="button" className="text-sm underline-offset-2 hover:underline" onClick={goToNearestMonth}>
              Go to {formatMonthLabel(nearestMonthWithReceipts)}, your nearest month with receipts
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">No receipts match this view.</p>
        ) : isMobile ? (
          <div className="space-y-3">
            {filtered.map((r) => (
              <ReceiptCard key={r.id} receipt={r} />
            ))}
          </div>
        ) : (
          <ReceiptsTable receipts={filtered} />
        )}
      </div>
    </div>
  );
}
