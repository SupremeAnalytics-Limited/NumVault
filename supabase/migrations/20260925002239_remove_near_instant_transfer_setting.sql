-- The per-order near-instant transfer feature has been removed entirely
-- (purchase-number and wallet-topup no longer read this key). Delete the
-- now-unused app_settings row.
delete from public.app_settings where key = 'near_instant_transfer_enabled';
