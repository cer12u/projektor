// @module workbench
// @role presenter
import {useProjectController,type ProjectManagementProps} from './project-controller';
import {ProjectManagementView} from './project-view';
export function ProjectManagement(props:ProjectManagementProps){return <ProjectManagementView model={useProjectController(props)}/>;}
