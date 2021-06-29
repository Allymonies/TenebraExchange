import Big from "big.js"

export interface CurrencyConstants {
    wallet_version: number;
    nonce_max_size: number;
    name_cost: number;
    min_work?: number;
    max_work?: number;
    work_factor?: number;
    seconds_per_block?: number;
}

export interface CurrencyInfo {
    address_prefix: string;
    name_suffix: string;
    currency_name: string;
    currency_symbol: string;
}

export interface Currency {
    syncNode: string;
    privateKey: string;
    address?: string;
    name: string;
    decimals: number;
    exchange: Record<string, Big>;
    constants?: CurrencyConstants;
    currency?: CurrencyInfo;
    ws?: WebSocket | any;
    send?: (to: string, amount: number | string, metadata: string) => void;
}