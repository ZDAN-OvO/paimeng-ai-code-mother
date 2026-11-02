import { CreditPage } from '@/components/billing/credit-page';
import { AdminGuard } from '@/components/providers';
import styles from '@/components/admin-view.module.css';

export default function Billing() {
  return <AdminGuard><main className={styles.adminPage}><CreditPage /></main></AdminGuard>;
}
