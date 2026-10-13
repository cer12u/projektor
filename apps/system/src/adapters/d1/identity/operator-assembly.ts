// @module identity
// @role composition-entry
import type {AuthDB} from '../primitives';
import type {SecureCredentialDelivery} from '../../../modules/identity/operator-contracts';
import {createIdentityOperatorApplication} from '../../../modules/identity/operator-application';
import {createOperatorPersistence} from './deployment-management';
import {digest,randomToken} from '../../crypto/passwords';
/** Only an approved operator host receives this DB binding and secure-delivery implementation. */
export function createIdentityOperator(db:AuthDB,delivery:SecureCredentialDelivery){return createIdentityOperatorApplication(createOperatorPersistence(db),{digest,randomToken},delivery);}
