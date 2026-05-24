import type {
  HTMLAttributes,
  TableHTMLAttributes,
  ThHTMLAttributes,
  TdHTMLAttributes,
} from 'react';
import styles from './Table.module.css';

interface DataTableProps extends TableHTMLAttributes<HTMLTableElement> {
  dense?: boolean;
  striped?: boolean;
}

export function DataTable({ dense, striped, className = '', ...rest }: DataTableProps) {
  return (
    <div className={styles.scroll}>
      <table
        {...rest}
        className={[
          styles.table,
          dense ? styles.dense : '',
          striped ? styles.striped : '',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      />
    </div>
  );
}

export function Thead(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} className={styles.thead} />;
}

export function Tbody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} className={styles.tbody} />;
}

export function Tr(props: HTMLAttributes<HTMLTableRowElement>) {
  return <tr {...props} />;
}

interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
}

export function Th({ numeric, className = '', ...rest }: ThProps) {
  return (
    <th
      {...rest}
      className={[styles.th, numeric ? styles.numeric : '', className].filter(Boolean).join(' ')}
    />
  );
}

interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
  mono?: boolean;
}

export function Td({ numeric, mono, className = '', ...rest }: TdProps) {
  return (
    <td
      {...rest}
      className={[styles.td, numeric ? styles.numeric : '', mono ? styles.mono : '', className]
        .filter(Boolean)
        .join(' ')}
    />
  );
}
