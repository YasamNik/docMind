import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { budgetApi, type BudgetCategory, type BudgetReceiptWithItems, type ReceiptFieldsPatch } from "@/lib/budget-api";
import { formatMoney, itemsTotalFor, reconciliationGap } from "@/lib/budget-summary";
import { formatDocumentDate } from "@/lib/format";

function categoryName(categories: BudgetCategory[], categoryId: string | null): string | null {
  return categories.find((c) => c.id === categoryId)?.name ?? null;
}

function EditReceiptForm({
  receipt,
  categories,
  onSubmit,
  submitting,
}: {
  receipt: BudgetReceiptWithItems;
  categories: BudgetCategory[];
  onSubmit: (patch: ReceiptFieldsPatch) => void;
  submitting: boolean;
}) {
  const [merchant, setMerchant] = useState(receipt.merchant ?? "");
  const [purchasedAt, setPurchasedAt] = useState(receipt.purchasedAt ?? "");
  const [currency, setCurrency] = useState(receipt.currency ?? "");
  const [total, setTotal] = useState(receipt.total === null ? "" : String(receipt.total));
  const [taxAmount, setTaxAmount] = useState(receipt.taxAmount === null ? "" : String(receipt.taxAmount));
  const [categoryId, setCategoryId] = useState(receipt.categoryId ?? "");

  function handleSubmit() {
    onSubmit({
      merchant: merchant.trim() || null,
      purchasedAt: purchasedAt || null,
      currency: currency.trim() ? currency.trim().toUpperCase() : null,
      total: total.trim() === "" ? null : Number(total),
      taxAmount: taxAmount.trim() === "" ? null : Number(taxAmount),
      categoryId: categoryId || null,
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="receipt-merchant">Merchant</Label>
        <Input id="receipt-merchant" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="receipt-date">Date</Label>
        <Input id="receipt-date" type="date" value={purchasedAt} onChange={(e) => setPurchasedAt(e.target.value)} />
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <Label htmlFor="receipt-total">Total</Label>
          <Input id="receipt-total" type="number" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} />
        </div>
        <div className="flex-1">
          <Label htmlFor="receipt-tax">Tax</Label>
          <Input id="receipt-tax" type="number" step="0.01" value={taxAmount} onChange={(e) => setTaxAmount(e.target.value)} />
        </div>
        <div className="w-24">
          <Label htmlFor="receipt-currency">Currency</Label>
          <Input id="receipt-currency" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor="receipt-category">Category</Label>
        <select
          id="receipt-category"
          className="w-full rounded-full border border-input bg-secondary px-3 py-1.5 text-sm"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">No category</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <Button disabled={submitting} onClick={handleSubmit}>
        Save
      </Button>
    </div>
  );
}

function ReceiptStatusInfo({ receipt }: { receipt: BudgetReceiptWithItems }) {
  if (receipt.status === "pending") {
    return (
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Reading receipt...
      </span>
    );
  }
  if (receipt.status === "needs_review") return <Badge variant="accent2">Needs review</Badge>;
  if (receipt.status === "failed") return <Badge variant="destructive">Failed to read</Badge>;
  return null;
}

function ItemRow({
  item,
  currency,
  categories,
  onCategoryChange,
}: {
  item: BudgetReceiptWithItems["items"][number];
  currency: string | null;
  categories: BudgetCategory[];
  onCategoryChange: (categoryId: string | null) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.description}</p>
        {(item.quantity !== null || item.unitPrice !== null) && (
          <p className="text-xs text-muted-foreground">
            {item.quantity !== null && `Qty ${item.quantity}`}
            {item.quantity !== null && item.unitPrice !== null && " · "}
            {item.unitPrice !== null && `${formatMoney(item.unitPrice, currency)} each`}
          </p>
        )}
      </div>
      <select
        aria-label={`Category for ${item.description}`}
        className="rounded-full border border-input bg-secondary px-3 py-1 text-xs"
        value={item.categoryId ?? ""}
        onChange={(e) => onCategoryChange(e.target.value || null)}
      >
        <option value="">Uncategorised</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <span className="w-20 shrink-0 text-right text-sm">{formatMoney(item.amount, currency)}</span>
    </div>
  );
}

export function ReceiptDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const { data: receipt } = useQuery({
    queryKey: ["budget", "receipt", id],
    queryFn: () => budgetApi.getReceipt(id),
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 3000 : false),
  });
  const { data: categories = [] } = useQuery({ queryKey: ["budget", "categories"], queryFn: budgetApi.listCategories });
  const duplicateOfId = receipt?.duplicateOfReceiptId ?? null;
  const { data: duplicate } = useQuery({
    queryKey: ["budget", "receipt", duplicateOfId],
    queryFn: () => budgetApi.getReceipt(duplicateOfId!),
    enabled: duplicateOfId !== null,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["budget", "receipt", id] });
    queryClient.invalidateQueries({ queryKey: ["budget", "receipts"] });
  };

  const updateReceipt = useMutation({
    mutationFn: (patch: ReceiptFieldsPatch) => budgetApi.updateReceipt(id, patch),
    onSuccess: () => {
      invalidate();
      setEditOpen(false);
      toast.success("Receipt updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const updateItem = useMutation({
    mutationFn: ({ itemId, categoryId }: { itemId: string; categoryId: string | null }) => budgetApi.updateItemCategory(id, itemId, categoryId),
    onSuccess: () => {
      invalidate();
      toast.success("Category updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const resolveDuplicate = useMutation({
    mutationFn: (action: "keep" | "delete") => budgetApi.resolveDuplicate(id, action),
    onSuccess: (result) => {
      if ("deleted" in result) {
        toast.success("Deleted");
        navigate("/budget");
        return;
      }
      invalidate();
      setConfirmDeleteOpen(false);
      toast.success("Kept both");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!receipt) return null;

  const gap = reconciliationGap(receipt);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {categoryName(categories, receipt.categoryId) && <Badge variant="accent">{categoryName(categories, receipt.categoryId)}</Badge>}
            <ReceiptStatusInfo receipt={receipt} />
          </div>
          <h1 className="font-heading text-2xl">{receipt.merchant ?? "Unknown merchant"}</h1>
          <p className="text-sm text-muted-foreground">
            {formatDocumentDate(receipt.purchasedAt)} · {formatMoney(receipt.total, receipt.currency)}
            {receipt.taxAmount !== null && <> · tax {formatMoney(receipt.taxAmount, receipt.currency)}</>}
          </p>
          <Link to={`/documents/${receipt.documentId}`} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            View original photo
          </Link>
        </div>
        <Button variant="outline" onClick={() => setEditOpen(true)}>
          Edit
        </Button>
      </div>

      {gap !== null && (
        <p className="text-sm text-org-accent-800">
          Items total {formatMoney(itemsTotalFor(receipt), receipt.currency)} does not match the printed total{" "}
          {formatMoney(receipt.total, receipt.currency)} (difference {formatMoney(Math.abs(gap), receipt.currency)}).
        </p>
      )}

      {receipt.status === "failed" && (
        <Card className="border-2 border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base">Could not read this receipt</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{receipt.note ?? "The photos could not be read."}</p>
          </CardContent>
        </Card>
      )}

      {receipt.duplicateOfReceiptId && (
        <Card className="border-2 border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base">Possible duplicate</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              This looks like the same purchase as{" "}
              <Link to={`/budget/receipts/${receipt.duplicateOfReceiptId}`} className="underline-offset-2 hover:underline">
                {duplicate ? `${duplicate.merchant ?? "another receipt"} on ${formatDocumentDate(duplicate.purchasedAt)} for ${formatMoney(duplicate.total, duplicate.currency)}` : "another receipt"}
              </Link>
              .
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => resolveDuplicate.mutate("keep")} disabled={resolveDuplicate.isPending}>
                Keep both
              </Button>
              <Button variant="destructive" onClick={() => setConfirmDeleteOpen(true)}>
                Delete this one
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {receipt.note && receipt.status === "needs_review" && !receipt.duplicateOfReceiptId && (
        <p className="text-sm text-muted-foreground">{receipt.note}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lines</CardTitle>
        </CardHeader>
        <CardContent>
          {receipt.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No lines read from this receipt yet.</p>
          ) : (
            receipt.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                currency={receipt.currency}
                categories={categories}
                onCategoryChange={(categoryId) => updateItem.mutate({ itemId: item.id, categoryId })}
              />
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit receipt</DialogTitle>
          </DialogHeader>
          <EditReceiptForm
            receipt={receipt}
            categories={categories}
            submitting={updateReceipt.isPending}
            onSubmit={(patch) => updateReceipt.mutate(patch)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this receipt?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Moves its photo and this record to trash. You can restore it from there. The other receipt keeps its own copy.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => resolveDuplicate.mutate("delete")} disabled={resolveDuplicate.isPending}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
