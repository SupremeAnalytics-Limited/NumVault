-- Fix account deletion: add ON DELETE CASCADE to all FKs referencing user_profiles.id
-- Without this, Supabase Auth.Admin.DeleteUser fails with a database error.

alter table public.acquisition_participants
  drop constraint acquisition_participants_user_id_fkey,
  add constraint acquisition_participants_user_id_fkey
    foreign key (user_id) references public.user_profiles(id) on delete cascade;

alter table public.orders
  drop constraint orders_user_id_fkey,
  add constraint orders_user_id_fkey
    foreign key (user_id) references public.user_profiles(id) on delete cascade;

alter table public.purchase_locks
  drop constraint purchase_locks_user_id_fkey,
  add constraint purchase_locks_user_id_fkey
    foreign key (user_id) references public.user_profiles(id) on delete cascade;

alter table public.referred_customers
  drop constraint referred_customers_customer_id_fkey,
  add constraint referred_customers_customer_id_fkey
    foreign key (customer_id) references public.user_profiles(id) on delete cascade;

alter table public.transactions
  drop constraint transactions_user_id_fkey,
  add constraint transactions_user_id_fkey
    foreign key (user_id) references public.user_profiles(id) on delete cascade;
