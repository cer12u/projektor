// @module work
// @role public-contract
// Compatibility facade: no implementation or state.
export type {BodyDocument, ParentKind, EditingResource, WikiDocument, CommentDocument, HistoryIssueSnapshot, ContentHistory} from './content-model';
export {resourceKey, idPrefix, uuidPattern, contentIdPattern, validContentId, scopeOf} from './content-identifiers';
export {bodyLimit, blankBodyAllowed} from './content-policy';
