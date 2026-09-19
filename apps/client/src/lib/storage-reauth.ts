import { useQuery, type QueryClient } from "@tanstack/react-query";

// No storage driver endpoint reports an ongoing reauthorization need today: a health
// check swallows the specific reason into a plain message, and the drivers list carries
// no such flag either. What does carry it is the storage.reauth_required error code on
// an operation that actually touches the driver, such as a document's file fetch. This
// module is the one shared place that turns "an operation against driver X just failed
// with that code" into a signal the Storage tab can read, using the query cache as the
// app's one existing store for state that spans pages, rather than adding a new one.
function reauthKey(driverId: string) {
  return ["storage-reauth", driverId] as const;
}

export function useStorageReauthRequired(driverId: string) {
  const { data } = useQuery({
    queryKey: reauthKey(driverId),
    queryFn: () => false,
    initialData: false,
    staleTime: Infinity,
  });
  return data;
}

export function markStorageReauthRequired(queryClient: QueryClient, driverId: string) {
  queryClient.setQueryData(reauthKey(driverId), true);
}

export function clearStorageReauthRequired(queryClient: QueryClient, driverId: string) {
  queryClient.setQueryData(reauthKey(driverId), false);
}
