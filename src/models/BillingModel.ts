import Stripe from 'stripe';
import {Configuration} from "../Configuration";
import ISubscription = Stripe.subscriptions.ISubscription;
import {PaymentMethod} from "../http/HttpTypes";
import {IPlansModel} from "./PlansModel";

export interface IBillingModel {

    /**
     * Cancel the customer's subscription
     * @param id the customer's id
     */
    cancel(id : string) : Promise<void>;

    /**
     * Create a customer in the billing system. Return the id
     */
    createCustomer(firstName: string, lastName: string, email: string) : Promise<string>;

    createPaymentMethod(billingId: string, token: string) : Promise<PaymentMethod>;

    deleteCustomer(id: string) : Promise<void>;

    deletePaymentMethod(billingId: string, methodId: string) : Promise<void>;

    /**
     * Retrieve the billing plan id that a customer is subscribed to
     * @param id
     */
    get(id : string) : Promise<string | null>;

    getPaymentMethods(billingId: string) : Promise<Array<PaymentMethod>>;

    setDefaultPaymentMethod(billingId: string, methodId: string) : Promise<void>;

    /**
     * Subscribe a customer to the specified plan
     * @param billingId the customer's id
     * @param planBillingId the plan's billing id
     */
    subscribe(billingId : string, planBillingId : string) : Promise<void>;
}

export enum SubscribeErrors {
    PAYMENT_FAILED = "PAYMENT_FAILED",
    NO_PAYMENT_METHOD = "NO_PAYMENT_METHOD"
}

export class MockBillingModel implements IBillingModel {
    private readonly customers : Map<string, {planId : string | null, paymentMethods: Array<PaymentMethod>}>;
    private nextId : number;

    constructor() {
        this.customers = new Map();
        this.nextId = 0;
    }

    cancel(id: string): Promise<void> {
        const c = this.customers.get(id);
        if (!c) {
            return Promise.reject(new Error("No such billing customer"));
        }

        c.planId = null;
        return Promise.resolve();
    }

    createCustomer(firstName: string, lastName: string, email: string): Promise<string> {
        const id : string = `${this.nextId++}`;
        this.customers.set(id, {planId : null, paymentMethods: []});
        return Promise.resolve(id);
    }

    async createPaymentMethod(billingId: string, token: string) : Promise<PaymentMethod> {
        const cust = this.customers.get(billingId);
        if (!cust) {
            throw new Error("No such customer");
        }

        const method = {id: `card_${token}`, cardInfo: {brand: "Schmisa", expMonth: 5, expYear: 99, last4: "1234"}, isDefault: cust.paymentMethods.length <= 0};
        cust.paymentMethods.push(method);
        return method;
    }

    async deleteCustomer(id: string): Promise<void> {
        this.customers.delete(id);
    }

    async deletePaymentMethod(billingId: string, methodId: string) : Promise<void> {
        const cust = this.customers.get(billingId);
        if (!cust) {
            throw new Error("No such customer");
        }

        cust.paymentMethods = cust.paymentMethods.filter((m) => {return m.id !== methodId});
    }

    get(id: string) : Promise<string | null> {
        const c = this.customers.get(id);
        if (!c) {
            return Promise.reject(new Error("No such billing customer"));
        }

        return Promise.resolve(c.planId);
    }

    async getPaymentMethods(billingId: string): Promise<Array<PaymentMethod>> {
        const c = this.customers.get(billingId);
        if (!c) {
            return Promise.reject(new Error("No such billing customer"));
        }
        return c.paymentMethods;
    }

    async setDefaultPaymentMethod(billingId: string, methodId: string): Promise<void> {
        const c = this.customers.get(billingId);
        if (!c) {
            return Promise.reject(new Error("No such billing customer"));
        }

        for (const method of c.paymentMethods) {
            method.isDefault = method.id === methodId;
        }
    }

    subscribe(id: string, planId: string): Promise<void> {
        const c = this.customers.get(id);
        if (!c) {
            return Promise.reject(new Error("No such billing customer"));
        }

        c.planId = planId;
        return Promise.resolve();
    }
}

export class StripeBillingModel implements IBillingModel {
    private readonly stripe : Stripe;
    private readonly plans : IPlansModel;

    constructor(config : Configuration, plans : IPlansModel) {
        this.stripe = new Stripe(config.stripe.secretKey, config.stripe.apiVersion);
        this.plans = plans;
    }

    cancel(id: string): Promise<void> {
        return this.findOurSubscription(id).then((sub) => {
            // No action needed if we aren't subscribed
            if (!sub || !sub.plan) {
                return Promise.resolve();
            }

            // Otherwise, cancel the sub
            return this.stripe.subscriptions.del(sub.id).then(() => {
                return Promise.resolve();
            });
        })
    }

    createCustomer(firstName: string, lastName: string, email: string): Promise<string> {
        return this.stripe.customers.create({name : `${firstName} ${lastName}`, email: email}).then((customer) => {
            return Promise.resolve(customer.id);
        })
    }

    async createPaymentMethod(billingId: string, token: string) : Promise<PaymentMethod> {
        const source = await this.stripe.customers.createSource(billingId, {source:token});
        const card = source as Stripe.ICard;
        const customer = await this.stripe.customers.retrieve(billingId);
        return {
            id: source.id,
            isDefault: source.id === customer.default_source,
            cardInfo: {
                brand: card.brand,
                expMonth: card.exp_month,
                expYear: card.exp_year,
                last4: card.last4
            }
        }
    }

    async deleteCustomer(id: string): Promise<void> {
        await this.stripe.customers.del(id);
    }

    async deletePaymentMethod(billingId: string, methodId: string) : Promise<void> {
        await this.stripe.customers.deleteSource(billingId, methodId);
    }

    get(id: string): Promise<string | null> {
        return this.findOurSubscription(id).then((sub) => {
            if (sub && sub.plan) {
                return Promise.resolve(sub.plan.id);
            }
            return Promise.resolve(null);
        })
    }

    async getPaymentMethods(billingId: string): Promise<PaymentMethod[]> {
        const obj = await this.stripe.customers.retrieve(billingId);

        // TODO support methods besides cards, if desired
        const cards = obj.sources ? obj.sources.data.filter((s) => {
            return s.object === "card";
        }) : [];

        return cards.map((c) => {
            const cardInfo = c as Stripe.ICard;
            return {
                id: c.id,
                isDefault: c.id === obj.default_source,
                cardInfo: {
                    brand: cardInfo.brand,
                    expMonth: cardInfo.exp_month,
                    expYear: cardInfo.exp_year,
                    last4: cardInfo.last4
                }
            }
        });
    }

    async setDefaultPaymentMethod(billingId: string, methodId: string): Promise<void> {
        await this.stripe.customers.update(billingId, {default_source: methodId});
    }

    async subscribe(id: string, planId: string): Promise<void> {
        const sub = await this.findOurSubscription(id);

        // If we don't have one, create one
        if (!sub || !sub.plan) {
            try {
                await this.stripe.subscriptions.create({customer: id, plan : planId});
            } catch(e) {
                if (e.code === "resource_missing") {
                    throw new Error(SubscribeErrors.NO_PAYMENT_METHOD);
                }
                else if (e.code) {
                    throw new Error(SubscribeErrors.PAYMENT_FAILED);
                }
                throw e;
            }
            return;
        }

        // If we do have an existing subscription:
        // No action needed if sub is already on desired plan
        if (sub.plan.id === planId) {
            return;
        }

        // action needed if sub is not on desired plan
        try {
            await this.stripe.subscriptions.update(sub.id, {plan:planId});
        } catch(e) {
            if (e.code === "resource_missing") {
                throw new Error(SubscribeErrors.NO_PAYMENT_METHOD);
            }
            else if (e.code) {
                throw new Error(SubscribeErrors.PAYMENT_FAILED);
            }
            throw e;
        }
    }

    // For testing - returns created plan id
    static createPlan(config : Configuration) : Promise<string> {
        const stripe = new Stripe(config.stripe.secretKey, config.stripe.apiVersion);
        return stripe.plans.create({amount: 0, currency: 'usd', interval: 'month', product: {name: 'StripeBillingModel Test Plan'}}).then((plan) => {
            return Promise.resolve(plan.id);
        })
    }

    private findOurSubscription(id : string) : Promise<ISubscription | null> {
        return this.stripe.subscriptions.list({customer:id, limit: 100}).autoPagingToArray({limit: 1000}).then((subs) => {
            const ourSub = subs.find((s) => {
                return !!(s && s.plan && this.plans.getByBillingId(s.plan.id));

            });

            if (ourSub && ourSub) {
                return Promise.resolve(ourSub);
            }
            return Promise.resolve(null);
        })
    }
}
